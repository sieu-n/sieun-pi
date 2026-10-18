import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readHostFile, type Host } from "./hosts.ts";

/**
 * Brings `local`, this box's copy of `path` on another box, up to date from the byte the copy ends at, so a JSONL transcript costs only its
 * new lines. The new bytes are written at that offset, never appended, so two processes that copy one file at once (the chat service and a
 * `hosts transcript` run) write the same bytes to the same place. A copy longer than the host's file (rewritten there) is fetched whole again.
 */
export async function mirrorFile(host: Host, path: string, local: string): Promise<void> {
  await mkdir(dirname(local), { recursive: true, mode: 0o700 });
  const have = await stat(local).then(info => info.size, () => 0);
  const read = await readHostFile(host, path, { from: have });
  if (read.size < have) {
    const whole = await readHostFile(host, path);
    const fresh = `${local}.${randomUUID()}.tmp`;
    await writeFile(fresh, whole.bytes, { mode: 0o600 });
    await rename(fresh, local);
    return;
  }
  const file = await open(local, constants.O_RDWR | constants.O_CREAT, 0o600);
  try { if (read.bytes.length) await file.write(read.bytes, 0, read.bytes.length, have); }
  finally { await file.close(); }
}
