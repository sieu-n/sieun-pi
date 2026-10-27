import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readHostFile, type Host } from "./hosts.ts";

/**
 * Brings `local`, this box's copy of `path` on another box, up to date from the byte the copy ends at, so a JSONL transcript costs only its
 * new lines. The new bytes are written at that offset, never appended, so two processes that copy one file at once (the chat service and a
 * `hosts transcript` run) write the same bytes to the same place. A copy longer than the host's file (rewritten there) is fetched whole again.
 * The size comes from the open copy, so a copy that `pruneMirror` deletes meanwhile never gets new bytes at an old offset.
 */
export async function mirrorFile(host: Host, path: string, local: string): Promise<void> {
  await mkdir(dirname(local), { recursive: true, mode: 0o700 });
  const file = await open(local, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const have = (await file.stat()).size;
    const read = await readHostFile(host, path, { from: have });
    if (read.size < have) {
      const whole = await readHostFile(host, path);
      const fresh = `${local}.${randomUUID()}.tmp`;
      await writeFile(fresh, whole.bytes, { mode: 0o600 });
      await rename(fresh, local);
      return;
    }
    if (read.bytes.length) await file.write(read.bytes, 0, read.bytes.length, have);
  } finally { await file.close(); }
}

/** Deletes each file under `root` that `keep` does not name, except a whole copy being written (`.tmp`), and returns the deleted paths. */
export async function pruneMirror(root: string, keep: ReadonlySet<string>): Promise<string[]> {
  const gone: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || keep.has(file) || entry.name.endsWith(".tmp")) continue;
    await rm(file, { force: true });
    gone.push(file);
  }
  return gone;
}
