// The replay of 01a17f25 (test/fixtures/slot-park-01a17f25-1028.jsonl) the slot-park surface tests share (test/fixtures/slot-park-01a17f25-1028.jsonl): parked on a pi-pool slot from 20:55:56Z, Prime's wake wrote
// provider_quota_resume "cancelled" at 21:16:40Z and ran no turn, queued again 21:22:09Z, ran at 21:22:15Z. Each surface of the chat service
// and d9 must read the wait as a wait: no "[job] ... failed" or "ended" notice, no check-in nudge or restart, no stuck step, the agents panel's
// "waits for a working slot, place N of M", no relay into a parked session, and Prime's park-stop notice never read as a cancel.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ID = "01a17f25-f22d-71ef-9327-e68919164bb4";
export const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const lines = readFileSync(new URL("./fixtures/slot-park-01a17f25-1028.jsonl", import.meta.url), "utf8").trim().split("\n");
const upTo = (iso: string) => lines.filter(line => (JSON.parse(line) as { timestamp: string }).timestamp <= iso);
export const at = (iso: string) => Date.parse(iso);
/** Parked 104th of 185 after its second slot-wait error. */
export const PARKED = upTo("2026-10-27T21:12:20.715Z");
/** After Prime's wake wrote provider_quota_resume "cancelled" and ran no turn. */
export const DROPPED = upTo("2026-10-27T21:17:00.755Z");
/** Queued again 104th of 193 after a message, before its turn ran. */
export const QUEUED = upTo("2026-10-27T21:22:12.687Z");
export const SLOT_ERROR = "pi-pool: this run waits for a working slot, place 104 of 185; the pool wakes it when the slot starts, or it asks again at 2026-10-27T21:32:21.000Z.";
export const EMPTY = { queued: new Map(), working: new Set<string>() };
export const LISTED = { queued: new Map([[ID, { position: 61, total: 170, since: at("2026-10-27T20:55:56.986Z") }]]), working: new Set<string>() };

/** An agent dir whose root session `ID` holds `body`, as `withFailedTurns` and d9's owner read find it. */
export async function agentDir(body: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slot-park-surfaces-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(join(dir, "sessions", `${ID}.jsonl`), body.join("\n") + "\n");
  return dir;
}
