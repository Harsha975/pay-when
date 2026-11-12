import fs from "node:fs";
import path from "node:path";

export type Status =
  | "awaiting_funding" | "armed" | "releasing" | "released"
  | "refunded" | "stopped";

export interface Watcher {
  type: "evidence" | "url" | "github_release" | "github_pr_merged";
  url: string | null;
  repo: string | null;      // owner/name
  pr_number: number | null;
}

export interface TimelineEntry { at: string; kind: string; text: string }
export interface EvidenceFile { name: string; mime: string; size: number; path: string }

export interface Contract {
  id: string;
  sentence: string;
  title: string;
  payee_name: string;
  payee_email: string;
  amount: string;
  currency: string;
  condition: string;
  criteria: string[];
  risks: string[];
  watcher: Watcher;
  deadline: string;
  veto_seconds: number;
  status: Status;
  releaseAt?: string;
  lastSnapshotHash?: string;
  evidence: { at: string; text: string; url?: string; files?: EvidenceFile[] }[];
  paypal: { orderId?: string; authId?: string; captureId?: string; payoutBatchId?: string; approveUrl?: string; mock: boolean };
  timeline: TimelineEntry[];
  createdAt: string;
}

const FILE = path.resolve("data/db.json");
let db: Record<string, Contract> = {};
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); };

export const all = () => Object.values(db).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const get = (id: string) => db[id];
export const put = (c: Contract) => { db[c.id] = c; save(); return c; };
export const log = (c: Contract, kind: string, text: string) => {
  c.timeline.push({ at: new Date().toISOString(), kind, text });
  save();
};
