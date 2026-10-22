import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";

/**
 * The field a client sets on a `prompt` command, bare or inside a command envelope, to name the session whose owner turn this box's pi-pool marks
 * (pool/turns.py `owner-turn`). The relay takes the field off, so the daemon gets the command it always got.
 */
export const OWNER_TURN_FIELD = "ownerTurn";
const KEY = Buffer.from(`"${OWNER_TURN_FIELD}"`);
const NEWLINE = 10;
/** A session id as the relay takes one from a client. */
export const SESSION = /^[\w-]+$/;

/** One `pi-pool` command on this box, resolving to its stdout; launchd gives the relay no ~/.local/bin on its PATH. */
function piPool(args) {
  const installed = join(homedir(), ".local/bin/pi-pool");
  return new Promise((resolve, reject) => {
    execFile(existsSync(installed) ? installed : "pi-pool", args, (error, stdout, stderr) => {
      if (error) reject(new Error((String(stderr).trim() || error.message).replace(/\s+/g, " ").slice(0, 300)));
      else resolve(String(stdout));
    });
  });
}

/** `pi-pool owner-turn <session>` on this box. */
export async function piPoolOwnerTurn(session) {
  await piPool(["owner-turn", session]);
}

/** `pi-pool lead <session>...` on this box: these sessions' queued runs start first; no sessions clears the list. */
export async function piPoolLead(sessions) {
  await piPool(["lead", ...sessions]);
}

function markedLine(line, mark, log) {
  let message;
  try { message = JSON.parse(line.toString("utf8")); } catch { return line; }
  const command = message?.type === "command" && message.command && typeof message.command === "object" ? message.command : message;
  if (!command || typeof command !== "object" || !(OWNER_TURN_FIELD in command)) return line;
  const session = command[OWNER_TURN_FIELD];
  delete command[OWNER_TURN_FIELD];
  if (typeof session === "string" && SESSION.test(session)) {
    void mark(session).catch(error => log(`owner turn for ${session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
  } else log(`owner turn: not a session id: ${String(session).slice(0, 40)}`);
  return Buffer.from(JSON.stringify(message) + "\n");
}

/**
 * The client-to-daemon byte stream, with each command that carries `ownerTurn` sent without the field while this box's pi-pool marks that
 * session's owner turn beside it. The chat service used to mark it over its own ssh, 0.6 to 0.9 s from us-metal02 to the Mac on 10-19, before
 * each owner send to a Mac chat. The prompt does not wait for the mark either: the local call took 89 to 98 ms on the Mac on 10-20, which held
 * every send that long, and the run's first admit comes later, at its first model call. A mark that still lands after that admit starts the
 * queued run at once as kind "ahead" (pool/turns.py mark_owner). Every other line passes as it came, in order.
 */
export function ownerTurnLines(mark = piPoolOwnerTurn, log = () => {}) {
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
      for (let at = 0, end = lines.indexOf(NEWLINE); end >= 0; at = end + 1, end = lines.indexOf(NEWLINE, at)) {
        const line = lines.subarray(at, end + 1);
        this.push(line.indexOf(KEY) < 0 ? line : markedLine(line, mark, log));
      }
      done();
    },
    flush(done) {
      if (parts.length) this.push(Buffer.concat(parts));
      done();
    },
  });
}
