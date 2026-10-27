import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hostExecFile } from "./spawn-host.ts";

/**
 * Every entry at or below `root`, read one folder at a time and never through a symbolic link. Node 26's readdir with `recursive: true`
 * follows a link to a folder and keeps 4 thread-pool reads out at once: a job's `node_modules` link to ~/src/sieun-pi/node_modules sent the
 * 10-min sweep of deleted jobs through the repo's packages until ELOOP, and in 7 minutes from 02:02 to 02:50Z on 10-27, each a sweep's, the chat's
 * own file reads waited 2.5 to 3.6 s for a pool thread. One such walk of chat 01a1164b's folder held all 4 threads for 3.1 s in a copy, then failed,
 * so the sweep found none of that chat's deleted jobs. An unreadable folder is skipped.
 */
export async function* walkTree(root: string): AsyncGenerator<Dirent> {
  const folders = [root];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      yield entry;
      if (entry.isDirectory()) folders.push(join(folder, entry.name));
    }
  }
}

/**
 * Deletes the tree at `path` with `rm -rf`, which runs outside the chat's thread pool; whether it is gone. fs.promises.rm queues an unlink
 * for every file at once: deleting 20,000 files in a copy held a stat behind it 172 ms on an idle box, at any pool size from 4 to 64, and
 * `rm -rf` held it 1 ms.
 */
export function removeTree(path: string): Promise<boolean> {
  return new Promise(resolve => { hostExecFile("rm", ["-rf", "--", path], {}, error => resolve(error === null)); });
}
