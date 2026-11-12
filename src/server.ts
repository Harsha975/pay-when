import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { parseSentence, judge, HAS_KEY } from "./ai.js";
import * as pp from "./paypal.js";
import { Contract, all, get, log, put } from "./store.js";
import { startLoop, refund, tick, finalizeIfDue } from "./engine.js";
import { saveFiles } from "./evidence.js";

const app = express();
app.use("/api/contracts/:id/evidence", express.json({ limit: "14mb" })); // 3 files x 3 MB as base64
app.use(express.json());
app.use(express.static("public"));
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const wrap = (f: express.RequestHandler): express.RequestHandler => (q, s, n) => Promise.resolve(f(q, s, n)).catch((e) => s.status(500).json({ error: e.message }));

app.get("/api/status", (_q, s) => s.json({ paypal: pp.MOCK ? "mock" : "sandbox", claude: HAS_KEY }));

// Step 1: sentence -> contract preview
app.post("/api/parse", wrap(async (q, s) => {
  const sentence = String(q.body.sentence ?? "").trim();
  if (sentence.length < 8) return s.status(400).json({ error: "Say a bit more." });
  s.json(await parseSentence(sentence));
}));

// Step 2: user confirmed -> create contract + PayPal hold
app.post("/api/contracts", wrap(async (q, s) => {
  const { sentence, parsed, payee_email, veto_seconds } = q.body;
  const email = String(payee_email || parsed.payee_email || "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return s.status(400).json({ error: "Payee PayPal email required." });
  if (!(Number(parsed.amount) > 0)) return s.status(400).json({ error: "Invalid amount." });
  const id = crypto.randomBytes(4).toString("hex");
  const hold = await pp.createHold(id, parsed.amount, parsed.currency, parsed.title, BASE);
  const c: Contract = {
    id, sentence, title: parsed.title, payee_name: parsed.payee_name, payee_email: email,
    amount: parsed.amount, currency: parsed.currency, condition: parsed.condition, criteria: parsed.criteria, risks: parsed.risks,
    watcher: parsed.watcher, deadline: new Date(Date.now() + parsed.deadline_days * 86400e3).toISOString(),
    veto_seconds: Math.max(0, Math.min(Number(veto_seconds ?? 30), 86400)),
    status: "awaiting_funding", evidence: [], timeline: [], createdAt: new Date().toISOString(),
    paypal: { orderId: hold.orderId, approveUrl: hold.approveUrl, mock: pp.MOCK },
  };
  log(c, "created", `Contract created from: "${sentence}"`);
  put(c); s.json(c);
}));

app.get("/api/contracts", (_q, s) => s.json(all()));
app.get("/api/contracts/:id", (q, s) => { const c = get(String(q.params.id)); c ? s.json(c) : s.sendStatus(404); });

async function arm(c: Contract) {
  const a = await pp.authorize(c.paypal.orderId!);
  c.paypal.authId = a.authId; c.status = "armed";
  log(c, "funded", `${c.amount} ${c.currency} is now HELD on PayPal (authorization ${a.authId}). Watching: ${c.condition}`);
  put(c);
}

// PayPal redirects the payer back here after approval
app.get("/paypal/return", wrap(async (q, s) => {
  const c = get(String(q.query.c));
  if (c && c.status === "awaiting_funding") await arm(c);
  s.redirect(`/?open=${q.query.c}`);
}));
// Mock approval page for offline demos
app.get("/mock/approve/:id", wrap(async (q, s) => {
  const c = get(String(q.params.id));
  if (c && c.status === "awaiting_funding") await arm(c);
  s.redirect(`/?open=${q.params.id}`);
}));

// Payee/anyone submits proof of delivery (for evidence-type watchers)
app.post("/api/contracts/:id/evidence", wrap(async (q, s) => {
  const c = get(String(q.params.id)); if (!c) return s.sendStatus(404);
  if (c.status !== "armed") return s.status(400).json({ error: "Contract is not armed." });
  let files; try { files = saveFiles(c.id, q.body.files); } catch (e: any) { return s.status(400).json({ error: e.message }); }
  const text = String(q.body.text ?? "").slice(0, 8000);
  if (!text.trim() && !files.length) return s.status(400).json({ error: "Add a description or a file." });
  c.evidence.push({ at: new Date().toISOString(), text, url: typeof q.body.url === "string" ? q.body.url.slice(0, 500) : undefined, files });
  log(c, "evidence", `Evidence submitted${files.length ? ` with ${files.length} file(s)` : ""}.`); put(c);
  await tick(c); s.json(get(c.id));
}));

// Payer manually confirms delivery (human-in-the-loop when the referee is unsure)
app.post("/api/contracts/:id/confirm", wrap(async (q, s) => {
  const c = get(String(q.params.id)); if (!c) return s.sendStatus(404);
  if (c.status !== "armed") return s.status(400).json({ error: "Contract is not armed." });
  c.status = "releasing"; c.releaseAt = new Date(Date.now() + c.veto_seconds * 1000).toISOString();
  log(c, "veto", `Payer confirmed delivery. Releasing in ${c.veto_seconds}s.`); put(c); s.json(c);
}));

// Payer vetoes during the release window
app.post("/api/contracts/:id/veto", wrap(async (q, s) => {
  const c = get(String(q.params.id)); if (!c) return s.sendStatus(404);
  if (c.status !== "releasing") return s.status(400).json({ error: "Nothing to veto." });
  c.status = "armed"; c.releaseAt = undefined; c.evidence = [];
  log(c, "veto", "Payer vetoed the release. Back to watching; evidence cleared."); put(c); s.json(c);
}));

// Payer cancels: void the hold
app.post("/api/contracts/:id/cancel", wrap(async (q, s) => {
  const c = get(String(q.params.id)); if (!c) return s.sendStatus(404);
  if (c.status === "released") return s.status(400).json({ error: "Already paid." });
  await refund(c, "Cancelled by payer."); s.json(get(c.id));
}));

// Demo helper: run the loop right now
app.post("/api/contracts/:id/check", wrap(async (q, s) => {
  const c = get(String(q.params.id)); if (!c) return s.sendStatus(404);
  await finalizeIfDue(c); await tick(c); s.json(get(c.id));
}));

startLoop(Number(process.env.POLL_MS ?? 10000));
app.listen(Number(process.env.PORT ?? 3000), () => console.log(`Pay-When on ${BASE}  | PayPal: ${pp.MOCK ? "MOCK" : "sandbox"} | Claude: ${HAS_KEY ? "ready" : "NO KEY"}`));
