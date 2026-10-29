/**
 * Moves the channels of before phase 5 onto rooms (server/migrate-channels.ts). A dry run by default: it prints, per channel, the room it
 * would write, how each member maps to an agent and how many posts it would append, and writes nothing. `--apply` writes them; a second run
 * writes nothing new. It never changes `channels.json` or `channels/<id>.jsonl`.
 *
 * Run `--apply` while no chat server uses the data dir: a running server keeps `rooms.json` and each room's posts in memory, so its next
 * save drops the new rows and its next post in a moved channel takes a seq the log already has.
 *
 *   node --import tsx scripts/migrate-channels.ts [--data-dir <dir>] [--apply]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { migrateChannels } from "../server/migrate-channels.ts";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const dataDir = resolve(values["data-dir"] ?? join(homedir(), ".pi/agent/chat"));
const started = Date.now();
const report = migrateChannels(dataDir, { apply: values.apply });
const verb = report.apply ? "wrote" : "would write";

console.log(`${report.apply ? "apply" : "dry run"} on ${dataDir}: ${report.channels.length} channels`);
for (const move of report.channels) {
  const { room } = move;
  console.log(`\n#${room.name} (${room.id})${room.archived ? " archived" : ""}: ${move.roomExisted ? "room already in rooms.json, kept as it is" : `${verb} room of kind channel`}`);
  console.log(`  purpose: ${room.purpose ? JSON.stringify(room.purpose) : "none"}${room.homeChat ? `, home chat ${room.homeChat}` : ""}`);
  console.log(`  members: ${move.members.length}${move.ownerDropped ? ", owner row dropped because the owner is in every room" : ""}`);
  for (const m of move.members) console.log(`    ${m.from} -> ${m.agent}${m.mapped ? "" : " (no agent holds it, kept as it is)"} wakeOn ${m.wakeOn}`);
  console.log(`  posts: ${move.posts} in the old log, ${move.present} already in the room, ${move.append.length} ${report.apply ? "appended" : "to append"}${move.append.length ? ` (${move.append.join(", ")})` : ""}`);
  for (const b of move.blocked) console.log(`  not written: ${b.post}, because ${b.reason}`);
  if (move.unmapped.length) console.log(`  ids no agent holds: ${move.unmapped.join(", ")}`);
}
console.log(`\n${verb}: ${report.apply ? report.roomsWritten : report.channels.filter(m => !m.roomExisted).length} rooms, ${report.apply ? report.postsWritten : report.channels.reduce((n, m) => n + m.append.length, 0)} posts, in ${Date.now() - started} ms`);
console.log(`ids no agent holds, kept as they are: ${report.unmapped.length ? report.unmapped.join(", ") : "none"}`);
const blocked = report.channels.flatMap(m => m.blocked.map(b => `${m.room.id} ${b.post}`));
if (blocked.length) {
  console.log(`posts not written: ${blocked.join(", ")}`);
  process.exitCode = 1;
}
