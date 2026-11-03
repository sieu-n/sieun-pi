/**
 * The duty precheck `scripts/duties/relay-posts.ts` on a data dir of its own: it counts the agent posts of the window that relay the agent's
 * own work, in real rooms only, and prints them as flagged rows; a test room, a test agent's post, an archived room, an owner post, a result
 * and a post outside the window count as nothing.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { relayPosts } from "../../scripts/duties/relay-posts.ts";

const dir = mkdtempSync(join(tmpdir(), "apps-chat-relay-posts-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 3, 3, 0);
const HOUR = 3600_000;

const member = (agent: string) => ({ agent, wakeOn: "all", addedAt: NOW - 100 * HOUR });
const room = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "channel", name: id, purpose: "", createdAt: NOW - 100 * HOUR, archived: false, members: [member("ag_vent")], ...extra });
const post = (roomId: string, seq: number, author: string, text: string, at: number) =>
  `${JSON.stringify({ t: "post", post: { room: roomId, id: `p${seq}`, seq, author, text, images: [], mentions: [], at, hops: 1, requestId: `r${seq}`, deliveries: [] } })}\n`;

mkdirSync(join(dir, "rooms"));
writeFileSync(join(dir, "agents.json"), JSON.stringify({ v: 1, aliases: {}, agents: [
  { id: "ag_vent", slug: "vent", name: "vent", room: "dm_vent", workThread: "w-vent", host: "us-metal02", home: "/tmp", createdAt: 0, archived: false },
  { id: "ag_walk", slug: "walk", name: "walk", room: "dm_walk", workThread: "w-walk", host: "us-metal02", home: "/tmp", createdAt: 0, archived: false, test: true },
] }));
writeFileSync(join(dir, "rooms.json"), JSON.stringify({ v: 1, feed: {}, rooms: [
  room("ch_real"), room("ch_walk", { test: true }), room("ch_old", { archived: true }),
  { id: "dm_vent", kind: "dm", agent: "ag_vent", createdAt: 0, archived: false },
  { id: "dm_walk", kind: "dm", agent: "ag_walk", createdAt: 0, archived: false },
] }));
const RELAY = "The vent thread is now listing every panel, including Vent, admin, Grafana and the rest, with its data, backend and a tested login, on one wiki page.";
writeFileSync(join(dir, "rooms", "ch_real.jsonl"), [
  post("ch_real", 1, "owner", "@vent list every panel, and I'll post the link once it's done", NOW - 2 * HOUR),
  post("ch_real", 2, "ag_vent", RELAY, NOW - 2 * HOUR + 30_000),
  post("ch_real", 3, "ag_vent", "Every panel is on one page now, with its data, backend and a tested login.", NOW - HOUR),
  post("ch_real", 4, "ag_vent", "I'll post the wiki link here once the list is done.", NOW - 30 * HOUR),
  post("ch_real", 5, "ag_walk", RELAY, NOW - HOUR),
].join(""));
writeFileSync(join(dir, "rooms", "dm_vent.jsonl"), post("dm_vent", 1, "ag_vent", "I passed that to the job vent integration health.", NOW - 3 * HOUR));
writeFileSync(join(dir, "rooms", "ch_walk.jsonl"), post("ch_walk", 1, "ag_vent", RELAY, NOW - HOUR));
writeFileSync(join(dir, "rooms", "ch_old.jsonl"), post("ch_old", 1, "ag_vent", RELAY, NOW - HOUR));
writeFileSync(join(dir, "rooms", "dm_walk.jsonl"), post("dm_walk", 1, "ag_walk", RELAY, NOW - HOUR));

test("relay posts count only an agent's relay lines of the window in real rooms", () => {
  const { findings, agentPosts } = relayPosts(dir, NOW, 24 * HOUR);
  assert.deepEqual(findings.map(f => [f.room, f.post, f.kind]), [["dm_vent", "p1", "handoff"], ["ch_real", "p2", "progress"]]);
  assert.equal(agentPosts, 3, "the result counts as an agent post, the walk's and the old ones do not");
});

test("the precheck writes the count, the window and one flagged row per relay post to OUTPUT_FILE", () => {
  const out = join(dir, "out.json");
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../../scripts/duties/relay-posts.ts"), "--data-dir", dir, "--hours", "1000000"], {
    env: { ...process.env, OUTPUT_FILE: out },
  });
  const output = JSON.parse(readFileSync(out, "utf8")) as { metrics: Record<string, number>; flagged: { kind: string; sig: string; excerpt: string }[] };
  assert.equal(output.metrics.relay_posts_24h, 3);
  assert.deepEqual(output.flagged.map(f => [f.kind, f.sig]), [["relay_handoff", "ch_real:p4"], ["relay_handoff", "dm_vent:p1"], ["relay_progress", "ch_real:p2"]]);
  assert.match(output.flagged[2]!.excerpt, /^ch_real p2 by ag_vent, "The vent thread is now listing": /);
});
