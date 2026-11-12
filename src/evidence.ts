import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceFile } from "./store.js";

export const MAX_FILES = 3;
export const MAX_BYTES = 3 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

/** Detect the real type from content, never from the client-supplied name or MIME. */
export function sniff(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (/<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8"))) return "image/svg+xml";
  return null;
}

/** Validate every file first, then write, so a bad upload leaves nothing behind. */
export function saveFiles(contractId: string, input: unknown): EvidenceFile[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);

  const parsed = input.map((f: any) => {
    const data = Buffer.from(String(f?.data ?? ""), "base64");
    if (!data.length || data.length > MAX_BYTES) throw new Error("Each file must be non-empty and at most 3 MB.");
    const mime = sniff(data);
    if (!mime) throw new Error("Unsupported file. Use PNG, JPG, WebP, GIF or SVG.");
    const name = String(f?.name ?? "file").replace(/[^\w.\- ]/g, "_").slice(0, 80);
    return { data, mime, name };
  });

  const dir = path.resolve("data/uploads", contractId);
  fs.mkdirSync(dir, { recursive: true });
  return parsed.map(({ data, mime, name }) => {
    const p = path.join(dir, `${crypto.randomBytes(6).toString("hex")}.${EXT[mime]}`);
    fs.writeFileSync(p, data);
    return { name, mime, size: data.length, path: p };
  });
}

export interface JudgeFile { name: string; mime: string; data: Buffer }

export function loadFiles(files: EvidenceFile[]): JudgeFile[] {
  const out: JudgeFile[] = [];
  for (const f of files) {
    try { out.push({ name: f.name, mime: f.mime, data: fs.readFileSync(f.path) }); } catch { /* file missing: referee sees the text note only */ }
  }
  return out;
}
