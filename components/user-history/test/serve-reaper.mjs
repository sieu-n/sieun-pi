// Kills every `chat-service-cli.mjs serve` a test started under its own directory, on every way the test can end.
// `chat start` runs serve detached, in its own process group, so neither the test's exit nor a Ctrl-C reaches it.
// reapServeOnExit starts this file as a detached watchdog that holds the read end of a pipe from the test process.
// The pipe closes when the test calls stop() and when the test process ends for any reason, SIGKILL included;
// the watchdog then stops each serve process whose command line names the directory, and exits.
import { execFileSync, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SERVE = "chat-service-cli.mjs serve";

function servePids(directory) {
  const listing = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  return listing.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && match[2].includes(SERVE) && match[2].includes(directory + "/") ? [Number(match[1])] : [];
  });
}

function signal(pids, name) {
  for (const pid of pids) {
    try { process.kill(pid, name); } catch { /* already gone */ }
  }
}

async function reap(directory) {
  const found = servePids(directory);
  signal(found, "SIGTERM");
  for (let attempt = 0; attempt < 30 && servePids(directory).length > 0; attempt++) await new Promise(done => setTimeout(done, 100));
  signal(servePids(directory), "SIGKILL");
  return found;
}

/** Starts the watchdog for `directory`. `stop()` reaps now and resolves with the serve PIDs it had to kill. */
export function reapServeOnExit(directory) {
  if (!isAbsolute(directory) || directory.split("/").filter(Boolean).length < 2) throw new Error(`Refusing to reap under ${directory}`);
  const watchdog = spawn(process.execPath, [fileURLToPath(import.meta.url), directory], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  watchdog.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  const exited = new Promise(done => watchdog.once("exit", done));
  watchdog.unref();
  watchdog.stdin.unref();
  watchdog.stdout.unref();
  return {
    pid: watchdog.pid,
    async stop() {
      watchdog.ref();
      watchdog.stdin.end();
      await exited;
      return output.trim() ? JSON.parse(output) : [];
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  let reaping = false;
  const finish = async () => {
    if (reaping) return;
    reaping = true;
    const killed = await reap(directory);
    // A test process that is gone leaves a broken pipe; the write fails and the watchdog still exits.
    process.stdout.write(JSON.stringify(killed) + "\n", () => process.exit(0));
  };
  process.stdout.on("error", () => {});
  process.stdin.on("end", finish).on("close", finish).on("error", finish).resume();
}
