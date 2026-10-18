import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** A chat's session file over this size is compacted after its next Prime compaction (scripts/session-compact.ts). */
export const AUTO_COMPACT_BYTES = 100 * 1000 * 1000;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/session-compact.ts", import.meta.url));

/**
 * Runs scripts/session-compact.ts --apply on one file in a child process, so its read, rewrite and checks never hold the service's main thread.
 * The script waits up to an hour for the daemon to list the session idle and for no process to hold the file open for writing, backs the file
 * up to ~/backups/session-compact-<date>/ with a manifest, and prints the file, its size before and after, and the backup path.
 */
export function runSessionCompact(file: string, socketPath: string, backupDir?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--apply", "--socket", socketPath, "--wait-seconds", "3600", ...(backupDir ? ["--backup-dir", backupDir] : []), file],
      { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => { if (code === 0) resolve(out.trim()); else reject(new Error(`session-compact exited ${code}: ${err.trim().slice(-500)}`)); });
  });
}

/**
 * The service's own session compaction. On 10-18 the biggest chat files were 136 to 172 MB, half of it old chat_board results and inline
 * images, and the session-compact job ran the script by hand. A chat's Prime compaction ends (`compacted`), and when its file is over
 * AUTO_COMPACT_BYTES the script runs on it, one run per file at a time, and the result goes to the service log.
 */
export class SessionAutoCompact {
  private readonly running = new Set<string>();
  constructor(private readonly options: { socketPath: string; log: (line: string) => void; minBytes?: number;
    run?: (file: string, socketPath: string) => Promise<string> }) {}

  /** Compacts `file` when it is over the size; resolves to the logged line, or null when it ran nothing. */
  async compacted(id: string, file: string | undefined): Promise<string | null> {
    if (!file || this.running.has(file)) return null;
    const size = await stat(file).then(found => found.size, () => 0);
    if (size <= (this.options.minBytes ?? AUTO_COMPACT_BYTES)) return null;
    this.running.add(file);
    let line: string;
    try { line = `session compact ${id.slice(0, 8)} ${file} (${(size / 1e6).toFixed(1)} MB): ${await (this.options.run ?? runSessionCompact)(file, this.options.socketPath)}`; }
    catch (error) { line = `session compact ${id.slice(0, 8)} ${file}: failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { this.running.delete(file); }
    this.options.log(line);
    return line;
  }
}
