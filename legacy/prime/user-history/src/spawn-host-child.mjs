// The spawn host's child (src/spawn-host.ts): runs each command the chat service sends on stdin as one JSON line, and writes its result as one
// JSON line. A fork copies the forking process's page tables, so a fork from this small process costs a few ms, where one from the chat's
// multi-GB process held the chat's event loop 39 ms at the median (1,546 spawns in 70 min on us-metal02 on 10-20).
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const send = line => { process.stdout.write(JSON.stringify(line) + "\n"); };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", text => {
  let request;
  try { request = JSON.parse(text); } catch { return; }
  const { id, file, args, cwd, env, timeout, maxBuffer, killSignal, input } = request;
  try {
    const child = execFile(file, args, { cwd, env, timeout, maxBuffer: maxBuffer === null ? Infinity : maxBuffer, killSignal }, (error, stdout, stderr) => {
      send({ id, stdout, stderr, error: error ? { message: error.message, code: error.code, signal: error.signal ?? null, killed: error.killed === true, cmd: error.cmd } : null });
    });
    if (typeof input === "string") child.stdin?.end(input);
    child.stdin?.on("error", () => {});
  } catch (error) {
    send({ id, stdout: "", stderr: "", error: { message: error instanceof Error ? error.message : String(error), code: error?.code, signal: null, killed: false } });
  }
});
process.stdin.on("end", () => process.exit(0));
