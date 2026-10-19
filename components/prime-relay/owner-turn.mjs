import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";

/**
 * The field a client sets on a `prompt` command, bare or inside a command envelope, to name the session whose owner turn this box's pi-pool marks
 * before the daemon reads the prompt (pool/turns.py `owner-turn`). The relay takes the field off, so the daemon gets the command it always got.
 */
export const OWNER_TURN_FIELD = "ownerTurn";
const KEY = Buffer.from(`"${OWNER_TURN_FIELD}"`);
const NEWLINE = 10;
/**
 * How long a prompt waits for its mark, a soft cap: the mark goes on behind it. The local `pi-pool` call took 86 ms on the Mac on 10-19 at 22:59Z,
 * and 3 s is the wait the chat service gave the ssh mark it replaces (REMOTE_OWNER_TURN_WAIT_MS), so a mark stuck on turns.lock never holds the
 * owner's message longer than it did.
 */
export const OWNER_TURN_WAIT_MS = 3000;
const SESSION = /^[\w-]+$/;

/** `pi-pool owner-turn <session>` on this box; launchd gives the relay no ~/.local/bin on its PATH. */
export function piPoolOwnerTurn(session) {
  const installed = join(homedir(), ".local/bin/pi-pool");
  return new Promise((resolve, reject) => {
    execFile(existsSync(installed) ? installed : "pi-pool", ["owner-turn", session], (error, _stdout, stderr) => {
      if (error) reject(new Error((String(stderr).trim() || error.message).replace(/\s+/g, " ").slice(0, 300)));
      else resolve();
    });
  });
}

async function markedLine(line, mark, log, waitMs) {
  let message;
  try { message = JSON.parse(line.toString("utf8")); } catch { return line; }
  const command = message?.type === "command" && message.command && typeof message.command === "object" ? message.command : message;
  if (!command || typeof command !== "object" || !(OWNER_TURN_FIELD in command)) return line;
  const session = command[OWNER_TURN_FIELD];
  delete command[OWNER_TURN_FIELD];
  if (typeof session === "string" && SESSION.test(session)) {
    let timer;
    const marked = mark(session).catch(error => log(`owner turn for ${session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    await Promise.race([marked, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  } else log(`owner turn: not a session id: ${String(session).slice(0, 40)}`);
  return Buffer.from(JSON.stringify(message) + "\n");
}

/**
 * The client-to-daemon byte stream, with each command that carries `ownerTurn` held until this box's pi-pool marks that session's owner turn and
 * sent without the field. The mark used to go from the chat service over its own ssh, which took 0.6 to 0.9 s from us-metal02 to the Mac on 10-19
 * and held every owner send to a Mac chat that long, 3 to 5 round trips. Here it costs the local call and keeps its order before the prompt, so
 * the run's first admit still finds it. Every other line passes as it came, in order.
 */
export function ownerTurnLines(mark = piPoolOwnerTurn, log = () => {}, waitMs = OWNER_TURN_WAIT_MS) {
  let parts = [];
  return new Transform({
    transform(chunk, _encoding, done) {
      if (chunk.indexOf(NEWLINE) < 0) { parts.push(chunk); return done(); }
      const data = parts.length ? Buffer.concat([...parts, chunk]) : chunk;
      parts = [];
      const last = data.lastIndexOf(NEWLINE);
      if (last + 1 < data.length) parts.push(data.subarray(last + 1));
      const lines = data.subarray(0, last + 1);
      if (lines.indexOf(KEY) < 0) { this.push(lines); return done(); }
      void (async () => {
        let at = 0;
        for (let end = lines.indexOf(NEWLINE, at); end >= 0; end = lines.indexOf(NEWLINE, at)) {
          const line = lines.subarray(at, end + 1);
          at = end + 1;
          this.push(line.indexOf(KEY) < 0 ? line : await markedLine(line, mark, log, waitMs));
        }
      })().then(() => done(), done);
    },
    flush(done) {
      if (parts.length) this.push(Buffer.concat(parts));
      done();
    },
  });
}
