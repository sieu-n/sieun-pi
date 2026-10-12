import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkInSettings } from "../../src/checkin-settings.ts";

/**
 * `node --import tsx scripts/duties/adopt-daemon-pause.ts --from <daemon-pause.json> [--data-dir <dir>]`: marks the check-in pause of each chat
 * the file lists (`{ chats: [id, ...] }`) as made by the daemon health gate, so the gate resumes it once the daemon answers again. Only a pause
 * until resumed made by the owner, an agent, or no author (a server before this script drops the `daemon` mark when it writes the file) changes
 * (the coordinator paused 8 chats by hand at 18:01Z on 10-09). Running it twice changes nothing.
 */
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const from = arg("--from");
if (!from) { process.stderr.write("usage: adopt-daemon-pause.ts --from <daemon-pause.json> [--data-dir <dir>]\n"); process.exit(2); }
const listed: unknown = JSON.parse(await readFile(resolve(from), "utf8"));
const chats = typeof listed === "object" && listed !== null && Array.isArray((listed as { chats?: unknown }).chats) ? (listed as { chats: unknown[] }).chats : [];
const settings = checkInSettings(join(arg("--data-dir") ? resolve(arg("--data-dir")!) : join(homedir(), ".prime/agent/browser-chat"), "check-in-settings.json"));
const known = await settings.all();
let adopted = 0;
for (const id of chats.filter((entry): entry is string => typeof entry === "string" && entry in known)) {
  let changed = false;
  await settings.update(id, current => {
    if (current.pausedUntil !== "forever" || current.pausedBy === "daemon") return current;
    changed = true;
    return { ...current, pausedBy: "daemon", setter: "gate" };
  });
  if (changed) { adopted++; process.stdout.write(`adopted ${id}\n`); }
}
process.stdout.write(`${adopted} adopted\n`);
