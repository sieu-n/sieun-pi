import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export class WorkspaceError extends Error {}

/** Turns what a person typed ("~/code/app", "/Users/me/app/") into the absolute path of a folder that exists. */
export async function resolveWorkspace(input: string, home = homedir()): Promise<string> {
  const typed = input.trim();
  if (!typed) throw new WorkspaceError("Type a folder path.");
  const expanded = typed === "~" ? home : typed.startsWith("~/") ? home + typed.slice(1) : typed;
  if (!isAbsolute(expanded)) throw new WorkspaceError(`Start the path with / or ~/: ${typed}`);
  const cwd = resolve(expanded);
  const info = await stat(cwd).catch(() => null);
  if (!info) throw new WorkspaceError(`No folder at ${typed}`);
  if (!info.isDirectory()) throw new WorkspaceError(`${typed} is a file, not a folder.`);
  return cwd;
}

/** Opens the macOS folder dialog on this Mac. Resolves null when the person cancels. */
export function chooseFolder(start: string | null): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new WorkspaceError("The folder dialog needs macOS. Type the path instead."));
  const script = [
    "on run argv",
    "activate",
    "set startPath to item 1 of argv",
    "if startPath is \"\" then",
    "return POSIX path of (choose folder with prompt \"Choose a workspace folder\")",
    "end if",
    "return POSIX path of (choose folder with prompt \"Choose a workspace folder\" default location (POSIX file startPath))",
    "end run",
  ];
  const args = script.flatMap(line => ["-e", line]).concat(start ?? "");
  return new Promise((done, fail) => {
    execFile("/usr/bin/osascript", args, { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      if (error) {
        if (/-128\b/.test(stderr)) { done(null); return; }
        const reason = stderr.trim().replace(/^\d+:\d+: execution error: /, "");
        fail(new WorkspaceError(error.killed || error.signal ? "The folder dialog closed before a folder was chosen." : "The folder dialog failed: " + (reason || "osascript exited with code " + String(error.code))));
        return;
      }
      const path = stdout.trim();
      done(path.length > 1 ? path.replace(/\/$/, "") : path);
    });
  });
}
