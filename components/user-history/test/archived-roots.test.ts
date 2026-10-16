import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { ChatAgent, ChatBoard, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * The daemon keeps listing an archived create_session root under its chat. On 10-14 the AI harness developer environment VP chat got two
 * "archived after N min quiet" notices for each of four roots, the second set at 17:50Z, a minute after the 17:49Z service start: stale tree
 * guard land (65 then 99 min), github signin land (597 then 101), vp worker heap fix (90 then 197) and harness footprint fix (135 then 242).
 * The ids, names and activity stamps below are the daemon's rows for them. github signin land is the one root that ran again in between: a
 * sibling's agent message resumed it at 16:07Z and it reported at 16:09Z, so it had a worker again.
 */
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const STALE = "01a13904-0527-73b8-ab31-a76ac4170a70";
const SIGNIN = "01a13904-3b07-77c6-9d7b-f6b2456467dc";
const FOOTPRINT = "01a13a3e-103d-70f9-a848-580a776e5501";
const HEAP = "01a13ab5-b4ca-750a-ae87-6ef12d8035b8";
const NAMES: Record<string, string> = { [STALE]: "stale tree guard land", [SIGNIN]: "github signin land", [FOOTPRINT]: "harness footprint fix", [HEAP]: "vp worker heap fix" };
const at = (iso: string) => Date.parse(iso);
const root = (sessionId: string, lastActivityAt: string): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name: NAMES[sessionId]!, job: `session:${sessionId}`, sender: NAMES[sessionId]!, link: "root", state: "idle", steps: [], lastActivityAt });
const said = (name: string): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from ${name}]\nDone; nothing is left on my side.`, display: true, timestamp: at("2026-10-14T13:48:00Z") }) as ThreadMessage;

/** The chat's roots as the daemon lists them (`agents`, `lifecycle`), and `serve()`, one service start: a new Chats over the same data dir. */
async function setup(agents: ChatAgent[]) {
  const dir = await mkdtemp(join(tmpdir(), "archived-roots-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  const loads = loadRecord(join(dir, "extension-loads.json"));
  for (const id of Object.keys(NAMES)) {
    await writeFile(join(dir, "sessions", `${id}.jsonl`), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `You are the job "${NAMES[id]}".` }] } }) + "\n");
    await loads.set(id, "b1");
  }
  const state = { agents, lifecycle: new Map<string, string>(Object.keys(NAMES).map(id => [id, "live"])), now: 0 };
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [] };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const calls: string[] = [];
  const serve = async () => {
    const threads = fakeThreads(calls);
    const archive = threads.archive.bind(threads);
    threads.archive = async (id: string) => { await archive(id); state.lifecycle.set(id, "archived"); };
    threads.transcripts.set(CHAT, Object.values(NAMES).map(said));
    const chats = new Chats(index, threads, async id => ({ lifecycle: state.lifecycle.get(id) ?? "live", sessionFile: join(dir, "sessions", `${id}.jsonl`) }), "b2", loads,
      { ...source(dir, { [CHAT]: board }, () => state.now, (): SessionRow[] => [row(CHAT, new Date(state.now).toISOString(), { chat: true, agents: state.agents })]),
        dutyJobs: async () => [], resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} } }, () => {});
    await chats.adopt();
    threads.fire().live(CHAT, []);
    await chats.settled();
    return chats;
  };
  const sweep = async (chats: Chats, iso: string) => { state.now = at(iso); await chats.tick(); await chats.settled(); };
  const archives = () => calls.filter(call => call.startsWith("archive ")).map(call => NAMES[call.slice("archive ".length)]);
  return { state, serve, sweep, archives };
}

test("a root the daemon lists as archived gets no second archive after a service start", async () => {
  const { serve, sweep, archives } = await setup([root(STALE, "2026-10-14T16:11:08.812Z"), root(SIGNIN, "2026-10-14T16:09:32.842Z"),
    root(FOOTPRINT, "2026-10-14T13:48:07.915Z"), root(HEAP, "2026-10-14T14:33:06.704Z")]);
  const first = await serve();
  await sweep(first, "2026-10-14T17:15:41Z");
  assert.deepEqual(archives(), ["stale tree guard land", "github signin land", "harness footprint fix", "vp worker heap fix"]);
  first.close();
  const second = await serve();
  await sweep(second, "2026-10-14T17:50:19Z");
  assert.deepEqual(archives().slice(4), [], "all four are archived on the daemon's list, so the 17:49Z start archives none again");
  second.close();
});

test("a root that ran again after its archive is archived once more in the same serve, since it has a worker again", async () => {
  const { state, serve, sweep, archives } = await setup([root(SIGNIN, "2026-10-14T06:06:37.844Z")]);
  const chats = await serve();
  await sweep(chats, "2026-10-14T16:03:52Z");
  assert.deepEqual(archives(), ["github signin land"]);
  await sweep(chats, "2026-10-14T16:20:00Z");
  assert.deepEqual(archives().slice(1), [], "still archived");
  state.agents = [root(SIGNIN, "2026-10-14T16:09:32.842Z")];
  state.lifecycle.set(SIGNIN, "live");
  await sweep(chats, "2026-10-14T17:10:00Z");
  assert.deepEqual(archives().slice(1), ["github signin land"]);
  chats.close();
});
