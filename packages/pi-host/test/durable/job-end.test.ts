/**
 * A pi job's end deletes what it owns, as Prime's chat service ends a deleted or archived job (user-history src/job-leftovers.ts):
 * 1. `rlm.delete_subagent` ends the child: its own ~/scratch/<thread>-<conversation> folder and the trees its owned.json records go, and
 *    another job's folder stays.
 * 2. An archive ends every conversation of the thread: the root's ~/scratch/<thread> folder, each child's folder and their records, and a
 *    recorded tree another job's record also names stays.
 * On 11-03 jobs 24920 and 24956 of thread 72ba1ed2 ended with their folders left, since a pi job's end deleted nothing.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { artifactDirOf } from "../../src/durable/children.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, context, entriesOf, firstUser, lastText, openThread, results, rlmOptions, say, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-job-end-"));
const home = join(dir, "home");
const scratch = join(home, "scratch");
process.env.HOME = home;
mkdirSync(scratch, { recursive: true });
mkdirSync(join(dir, "threads"));
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

let rlm: DurableRlm;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const record = (folder: string, paths: string[]) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "owned.json"), JSON.stringify({ paths, units: [] }));
};
const tree = (...names: string[]) => { for (const name of names) mkdirSync(join(scratch, name, "tree"), { recursive: true }); };

test("rlm.delete_subagent deletes the child's own scratch folder and the trees its owned.json records, and leaves another job's folder", async () => {
  const id = randomUUID();
  const file = join(dir, "threads", `${id}.sqlite`);
  const { harness, root } = await openThread(file, id, rlm, ({ messages }) => {
    const last = lastText(messages);
    if (firstUser(messages).startsWith("[task from parent]")) return say("done");
    if (last === "spawn") return cell(`h = await rlm.spawn("work", name="worker")\nprint("spawned", h.name)`);
    if (last.includes("spawned worker")) return say("spawned");
    if (last.startsWith("[child-exited")) return say("noted");
    if (last === "delete") return cell(`r = await rlm.delete_subagent("worker")\nprint("deleted", r.status)`);
    return say("ok");
  }, dir);
  await (await root.submit({ type: "input", content: "spawn" }, context)).wait(context);
  const child = await until("the child conversation", async () => (await harness.commit(async tx => (await tx.scanConversations({ ownerConversationId: 1 as never }, 10)).items, context)).find(c => c.id !== 1));
  await until("the child's notice", async () => (await entriesOf(harness)).some(e => JSON.stringify(e.model ?? "").includes("child-exited")));
  const own = `${id}-${child.id}`;
  const sibling = `${id}-${child.id + 100}`;
  tree(own, sibling, "worker-rig");
  record(artifactDirOf(file, id, child.id), [join(scratch, "worker-rig")]);
  record(artifactDirOf(file, id, child.id + 100), [join(scratch, sibling)]);
  await (await root.submit({ type: "input", content: "delete" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread(id, "idle");
  assert.equal(out.at(-1)?.text.trim(), "deleted completed");
  assert.ok(!existsSync(join(scratch, own)), "the child's own folder is gone");
  assert.ok(!existsSync(join(scratch, "worker-rig")), "the tree its owned.json recorded is gone");
  assert.ok(existsSync(join(scratch, sibling, "tree")), "another job's folder stays");
});

test("archiving a thread ends each of its conversations, and keeps a recorded tree another job's record also names", async () => {
  const durable = join(dir, "durable");
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  const models = () => { const out = createModels(); out.setProvider(faux.provider); return out; };
  const threads = new DurableThreads({ dir: durable, models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm });
  const thread = await threads.create({ name: "archive me" });
  const other = await threads.create({ name: "stays" });
  const file = threads.fileOf(thread.id);
  const artifacts = join(dirname(dirname(file)), "session-artifacts");
  record(artifactDirOf(threads.fileOf(other.id), other.id, 7), [join(scratch, "shared-rig")]);
  record(join(artifacts, `${thread.id}-1`), [join(scratch, "root-rig")]);
  record(join(artifacts, `${thread.id}-5`), [join(scratch, "job-rig"), join(scratch, "shared-rig")]);
  tree(thread.id, `${thread.id}-5`, `${other.id}-7`, "root-rig", "job-rig", "shared-rig");
  const ended: string[] = [];
  const endThread = rlm.endThread.bind(rlm);
  let done!: () => void;
  const finished = new Promise<void>(resolve => (done = resolve));
  rlm.endThread = async (id, at) => { ended.push(id); try { await endThread(id, at); } finally { done(); } };
  try {
    await threads.set(other.id, { name: "still here" });
    await threads.set(thread.id, { archived: true });
    await finished;
  } finally {
    rlm.endThread = endThread;
    await threads.shutdown();
  }
  assert.deepEqual(ended, [thread.id]);
  for (const name of [thread.id, `${thread.id}-5`, "root-rig", "job-rig"]) assert.ok(!existsSync(join(scratch, name)), `${name} is gone`);
  for (const name of [`${other.id}-7`, "shared-rig"]) assert.ok(existsSync(join(scratch, name, "tree")), `${name} stays`);
});
