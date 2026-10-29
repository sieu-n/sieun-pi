/**
 * Moves today's chats to agents and DM rooms (server/migrate.ts). A dry run by default: it prints the agents, aliases, posts per room,
 * cursors and board files it would write, and writes nothing. `--apply` writes them; a second run writes nothing new.
 *
 *   node --import tsx scripts/migrate-agents.ts [--data-dir <dir>] [--socket <pi-host socket>] [--apply] [--days 30] [--samples 5]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PiHost } from "../server/host/pi-host.ts";
import { migrateAgents, type PostDraft } from "../server/migrate.ts";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    socket: { type: "string" },
    apply: { type: "boolean", default: false },
    days: { type: "string", default: "30" },
    samples: { type: "string", default: "3" },
  },
});
const dataDir = resolve(values["data-dir"] ?? join(homedir(), ".pi/agent/chat"));
const socket = values.socket ?? join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "pi-host/host.sock");
const samples = Number(values.samples);

const host = new PiHost(socket);
try {
  const report = await migrateAgents(host, dataDir, { apply: values.apply, days: Number(values.days), log: line => console.log(line) });
  const verb = report.apply ? "wrote" : "would write";
  const clip = (text: string) => text.replace(/\s+/g, " ").slice(0, 140);
  const line = (post: PostDraft) => `    ${new Date(post.at).toISOString()} ${post.author} ${post.requestId}${post.jobs?.length ? ` jobs ${post.jobs.length}` : ""}: ${clip(post.text)}`;
  console.log(`\n${report.apply ? "apply" : "dry run"} on ${dataDir}, history since ${new Date(report.since).toISOString()}, ${report.ms} ms`);
  for (const agent of report.agents) {
    if (!agent.created) {
      console.log(`\n${agent.id} "${agent.name}" already exists: nothing to write`);
      continue;
    }
    const owner = agent.posts.filter(p => p.author === "owner").length;
    console.log(`\n${agent.id} "${agent.name}" (thread ${agent.thread}) ${verb} room ${agent.room}`);
    console.log(`  posts: ${agent.posts.length} (${owner} owner, ${agent.posts.length - owner} agent) from ${agent.entriesRead} entries`);
    console.log(`  cursor: entry ${agent.cursor?.entry}, open calls ${Object.keys(agent.cursor?.open ?? {}).length}, turn ${JSON.stringify(agent.cursor?.turn ?? null)}`);
    console.log(`  read mark: ${agent.readSeq === undefined ? "none" : `seq ${agent.readSeq}`}`);
    console.log(`  board files: ${agent.copied.length ? agent.copied.join(", ") : "none"}`);
    if (samples > 0 && agent.posts.length) {
      console.log(`  newest ${Math.min(samples, agent.posts.length)} posts:`);
      for (const post of agent.posts.slice(-samples)) console.log(line(post));
    }
  }
  const aliases = Object.entries(report.aliases);
  console.log(`\naliases ${verb}: ${aliases.length}`);
  for (const [thread, agent] of aliases) console.log(`  ${thread} -> ${agent}`);
} finally {
  await host.close();
}
