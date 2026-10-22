import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The last provider request of each session, as the extension's `before_provider_request` handler saw it: the final payload, after every
 * extension that rewrites it, since user-history loads last and no other extension in ~/.prime/agent/extensions hooks the event.
 * `<dataDir>/prompts/<sessionId>.json`, rewritten on every call; `api/threads/<id>/prompt` reads it (src/prompt-view.ts).
 */
export type PromptCapture = {
  capturedAt: string;
  sessionId: string;
  sessionFile: string | null;
  provider: string;
  model: string;
  payload: unknown;
};

export const PROMPTS_DIR = "prompts";

export function captureFile(dataDir: string, sessionId: string): string {
  return join(dataDir, PROMPTS_DIR, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

const chains = new Map<string, Promise<void>>();
let serial = 0;

/**
 * Serializes the capture now, while the payload is the one going on the wire, and writes it (tmp + rename) without holding the request.
 * The returned promise settles when the file is in place; the handler does not await it. A failed write is dropped.
 */
export function recordPrompt(dataDir: string, capture: PromptCapture): Promise<void> {
  const file = captureFile(dataDir, capture.sessionId);
  const body = JSON.stringify(capture);
  const temporary = `${file}.${process.pid}.${++serial}.tmp`;
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await mkdir(join(dataDir, PROMPTS_DIR), { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, file);
    } catch { await rm(temporary, { force: true }).catch(() => {}); }
  });
  chains.set(file, next);
  void next.then(() => { if (chains.get(file) === next) chains.delete(file); });
  return next;
}

export async function readCapture(dataDir: string, sessionId: string): Promise<PromptCapture | null> {
  let raw: string;
  try { raw = await readFile(captureFile(dataDir, sessionId), "utf8"); } catch { return null; }
  return parseCapture(raw, sessionId);
}

/** A capture file's text, from this box or read through another box's relay; null when it is not `sessionId`'s capture. */
export function parseCapture(raw: string, sessionId: string): PromptCapture | null {
  try {
    const value = JSON.parse(raw) as Partial<PromptCapture>;
    if (typeof value !== "object" || value === null || value.sessionId !== sessionId || typeof value.capturedAt !== "string") return null;
    return { capturedAt: value.capturedAt, sessionId, sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
      provider: typeof value.provider === "string" ? value.provider : "", model: typeof value.model === "string" ? value.model : "", payload: value.payload };
  } catch { return null; }
}
