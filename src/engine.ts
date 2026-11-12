import crypto from "node:crypto";
import { Contract, EvidenceFile, all, log, put } from "./store.js";
import { judge } from "./ai.js";
import { loadFiles } from "./evidence.js";
import * as pp from "./paypal.js";

const CONFIDENCE_TO_RELEASE = 0.85;
const GH = (p: string) => fetch(`https://api.github.com${p}`, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "pay-when", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
});

interface Obs { text: string; files: EvidenceFile[] }
const T = (text: string): Obs => ({ text, files: [] });

/** Look at the world. Returns text and files for the referee, or null if nothing new to judge. */
async function observe(c: Contract): Promise<Obs | null> {
  const w = c.watcher;
  if (w.type === "evidence") {
    if (!c.evidence.length) return null;
    const text = c.evidence.map((e) => `[${e.at}] ${e.text}${e.url ? `\nlink: ${e.url}` : ""}${e.files?.length ? `\nattached: ${e.files.map((f) => `${f.name} (${f.mime}, ${f.size} bytes)`).join(", ")}` : ""}`).join("\n---\n");
    const h = crypto.createHash("sha1").update(text).digest("hex");
    if (h === c.lastSnapshotHash) return null; // already judged, don't burn tokens
    c.lastSnapshotHash = h;
    return { text, files: c.evidence.flatMap((e) => e.files ?? []) };
  }
  if (w.type === "github_release" && w.repo) {
    const r = await GH(`/repos/${w.repo}/releases?per_page=5`);
    if (!r.ok) return null;
    const rel: any[] = await r.json();
    const fresh = rel.filter((x) => x.published_at > c.createdAt && !x.draft);
    if (!fresh.length) return null;
    return T(fresh.map((x) => `Release ${x.tag_name} "${x.name}" published ${x.published_at}\n${x.body ?? ""}`).join("\n---\n"));
  }
  if (w.type === "github_pr_merged" && w.repo) {
    const path = w.pr_number ? `/repos/${w.repo}/pulls/${w.pr_number}` : `/repos/${w.repo}/pulls?state=closed&per_page=5`;
    const r = await GH(path);
    if (!r.ok) return null;
    const j: any = await r.json();
    const prs: any[] = Array.isArray(j) ? j : [j];
    const merged = prs.filter((p) => p.merged_at && p.merged_at > c.createdAt);
    if (!merged.length) return null;
    return T(merged.map((p) => `PR #${p.number} "${p.title}" merged at ${p.merged_at} by ${p.merged_by?.login}\n${p.body ?? ""}`).join("\n---\n"));
  }
  if (w.type === "url" && w.url) {
    const r = await fetch(w.url, { headers: { "User-Agent": "pay-when" }, redirect: "follow" }).catch(() => null);
    if (!r?.ok) return null;
    const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const h = crypto.createHash("sha1").update(text).digest("hex");
    if (h === c.lastSnapshotHash) return null; // unchanged, don't burn tokens
    c.lastSnapshotHash = h;
    return T(`Page ${w.url} currently says:\n${text.slice(0, 8000)}`);
  }
  return null;
}

export async function tick(c: Contract) {
  if (c.status !== "armed") return;

  if (new Date() > new Date(c.deadline)) return refund(c, "Deadline passed without the condition being met.");

  const obs = await observe(c).catch((e) => { log(c, "error", `watcher error: ${e.message}`); return null; });
  put(c);
  if (!obs) return;

  log(c, "observe", "New evidence seen. Asking the referee...");
  const v = await judge(c, obs.text, loadFiles(obs.files)).catch((e) => {
    c.lastSnapshotHash = undefined; // let the next poll retry
    throw e;
  });
  log(c, "verdict", `${v.verdict.toUpperCase()} (${Math.round(v.confidence * 100)}%): ${v.reasoning}${v.missing.length ? ` Missing: ${v.missing.join("; ")}` : ""}`);

  if (v.verdict === "satisfied" && v.confidence >= CONFIDENCE_TO_RELEASE) {
    c.status = "releasing";
    c.releaseAt = new Date(Date.now() + c.veto_seconds * 1000).toISOString();
    log(c, "veto", `Condition met. Payment releases in ${c.veto_seconds}s unless the payer vetoes.`);
  }
  put(c);
}

export async function finalizeIfDue(c: Contract) {
  if (c.status !== "releasing" || !c.releaseAt || new Date() < new Date(c.releaseAt)) return;
  try {
    const r = await pp.captureAndPay(c.paypal.authId!, c.amount, c.currency, c.payee_email, c.id, `Pay-When: ${c.title}`);
    Object.assign(c.paypal, r);
    c.status = "released";
    log(c, "paid", `Captured held funds and paid ${c.payee_name} ${c.amount} ${c.currency}. Payout ${r.payoutBatchId}`);
  } catch (e: any) {
    c.status = "armed"; // retry next tick; funds are still held
    log(c, "error", `Release failed, will retry: ${e.message}`);
  }
  put(c);
}

export async function refund(c: Contract, why: string) {
  try {
    if (c.paypal.authId) await pp.voidHold(c.paypal.authId);
    c.status = "refunded";
    log(c, "refund", `${why} Hold voided, money stays with the payer.`);
  } catch (e: any) { log(c, "error", `Void failed: ${e.message}`); }
  put(c);
}

let running = false;
export function startLoop(ms = 15000) {
  setInterval(async () => {
    if (running) return; running = true;
    try {
      for (const c of all()) { await finalizeIfDue(c); await tick(c).catch((e) => log(c, "error", e.message)); }
    } finally { running = false; }
  }, ms);
}
