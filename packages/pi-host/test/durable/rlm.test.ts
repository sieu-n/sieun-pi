/**
 * Prime's `ipython` in durable threads (`rlm.ts`) and children that run beside their parent (`children.ts`, `subagent.ts`):
 * 1. Every conversation is offered `ipython` with the definition pi-rlm's extension registers, which `scripts/prompt-parity.mjs` compares
 *    byte for byte with a live Prime capture.
 * 2. The kernel keeps its state across calls and turns, and imports the Python skills the prompt lists.
 * 3. `rlm.spawn` returns at admission; the parent's run ends, an input sent while the child works is answered at once, and the child's
 *    notice arrives later as its own input. A child that replies with agent_message.send sends no notice. list_subagents sees both.
 * 4. The subagent tool returns at once too: a steer sent while a child runs for two minutes is answered within one generation, and the
 *    child's whole answer arrives as an input when it ends.
 * 5. A pi-host kill mid-cell gives that call pi-durable's `interrupted`; the next call starts a fresh kernel with pi-rlm's reset note, and
 *    the old kernel is gone.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { LiveDoc } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { KERNEL_RESET } from "../../../pi-rlm/src/pi/index.ts";
import { DurableRlm, IPYTHON_TOOL, loadIpythonTool } from "../../src/durable/rlm.ts";
import { SUBAGENT_STARTED } from "../../src/durable/subagent.ts";
import { call, cell, context, entriesOf, firstUser, inputs, lastText, openThread, results, rlmOptions, say, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-rlm-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
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

const offered = (messages: readonly Message[]) => getCurrentTools(messages as never).map(tool => toToolDeclaration(tool));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("every conversation is offered ipython with pi-rlm's own definition, and the kernel keeps its state across calls and turns", async () => {
  const tool = await loadIpythonTool();
  let tools: ReturnType<typeof offered> = [];
  const { harness, root } = await openThread(join(dir, "threads", "state.sqlite"), "state", rlm, ({ messages }) => {
    tools = offered(messages);
    const last = lastText(messages);
    if (last === "set x") return cell("x = 41\nimport pyskill\nprint('set', type(pyskill).__name__)");
    if (last.includes("set module")) return say("x is set");
    if (last === "read x") return cell("print(x + 1)");
    if (last.trim() === "42") return say("42");
    return say(`unexpected: ${last}`);
  }, dir);
  await (await root.submit({ type: "input", content: "set x" }, context)).wait(context);
  await (await root.submit({ type: "input", content: "read x" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread("state", "idle");
  const ipython = tools.find(t => t.name === IPYTHON_TOOL);
  assert.deepEqual(ipython, toToolDeclaration({ name: tool.name, description: tool.description, parameters: tool.parameters as never }));
  assert.ok(tools.some(t => t.name === "subagent"));
  assert.deepEqual(out.map(r => [r.name, r.text.trim(), r.isError]), [[IPYTHON_TOOL, "set module", false], [IPYTHON_TOOL, "42", false]]);
});

test("rlm.spawn returns at admission, the parent answers while the child works, and the child's notice or reply arrives as its own input", async () => {
  let releaseChild!: () => void;
  const childGate = new Promise<void>(resolve => (releaseChild = resolve));
  const { harness, root } = await openThread(join(dir, "threads", "spawn.sqlite"), "spawn", rlm, async ({ messages }) => {
    const first = firstUser(messages);
    const last = lastText(messages);
    if (first.startsWith("[task from parent]\n\ncount to 7")) {
      await childGate;
      return say("seven");
    }
    if (first.startsWith("[task from parent]\n\nreply to me")) {
      if (last.includes("[task from parent]")) return cell(`r = await agent_message.send("done: 5", receiver_role="parent")\nprint(r["deliveryStatus"])`);
      return say("replied");
    }
    if (last === "spawn") return cell(`h = await rlm.spawn("count to 7", name="counter")\nprint(h.name, h.rlm_child_id.startswith("sub-"), h.model, bool(h.session_dir))`);
    if (last.includes("counter True")) return say("spawned the counter");
    if (last.startsWith("status?")) return say("still waiting on the counter");
    if (last.startsWith("[child-exited: no-reply child:counter]")) return cell(`h = await rlm.spawn("reply to me", name="replier")\nprint("second", h.name)`);
    if (last.includes("second replier")) return say("spawned the replier");
    if (last.startsWith("[agent-message from child:replier]")) return cell(`print(sorted(r.session_name for r in await rlm.list_subagents()))`);
    if (last.includes("['counter', 'replier']")) return say("both listed");
    return say(`unexpected: ${last.slice(0, 120)}`);
  }, dir);
  const started = Date.now();
  const spawned = await (await root.submit({ type: "input", content: "spawn" }, context)).wait(context);
  assert.equal(spawned.status, "done");
  const child = await until("the child conversation", async () => (await harness.commit(async tx => (await tx.scanConversations({ ownerConversationId: 1 as never }, 10)).items, context)).find(c => c.id !== 1));
  assert.ok((await harness.snapshot(LiveDoc, child.id, context))?.run, "the child still runs after the parent's turn ended");
  const steer = await (await root.submit({ type: "input", content: "status? the owner asks", whenBusy: "steer" }, context)).wait(context);
  assert.equal(steer.status, "done", "an input sent while the child works is answered without waiting for it");
  assert.ok((await harness.snapshot(LiveDoc, child.id, context))?.run, "the child was still running when the parent answered");
  releaseChild();
  await until("both listed", async () => results(await entriesOf(harness)).some(r => r.text.includes("['counter', 'replier']")) && (await entriesOf(harness)).at(-1)?.kind === "pi.assistant", 120_000)
    .catch(async error => { for (const c of [1, 2, 3]) process.stdout.write(`# conv ${c}: ${JSON.stringify((await entriesOf(harness, c)).map(e => [e.kind, JSON.stringify(e.model?.[0]?.content ?? "").slice(0, 160)]))}\n`); throw error; });
  const rootInputs = inputs(await entriesOf(harness));
  const spawnCell = results(await entriesOf(harness)).find(r => r.text.includes("counter True"))!;
  assert.deepEqual(spawnCell.details, { conversationId: child.id, conversations: [child.id] }, "apps/chat finds the job pill in the cell's details");
  await harness.close(context);
  await rlm.closeThread("spawn", "idle");
  const notice = rootInputs.find(i => i.text.startsWith("[child-exited: no-reply child:counter]"))!;
  assert.equal(notice.text, "[child-exited: no-reply child:counter]\n\nLast assistant text: seven");
  assert.deepEqual(notice.data, { from: `spawn:${child.id}`, via: "rlm.child" });
  const reply = rootInputs.find(i => i.text.startsWith("[agent-message from child:replier]"))!;
  assert.equal(reply.text, "[agent-message from child:replier]\n\ndone: 5");
  assert.equal(reply.data?.via, "agent_message");
  assert.ok(!rootInputs.some(i => i.text.includes("child:replier]") && i.text.startsWith("[child-exited")), "a child that replied sends no notice");
  assert.ok(Date.now() - started < 120_000);
});

test("the subagent tool returns at once, and a steer sent while its child runs for two minutes is answered within one generation", { timeout: 300_000 }, async () => {
  const HOLD_MS = Number(process.env.RLM_TEST_CHILD_MS ?? 120_000);
  let childStarted = 0;
  let childDone = 0;
  const { harness, root } = await openThread(join(dir, "threads", "subagent.sqlite"), "sub", rlm, async ({ messages }) => {
    const first = firstUser(messages);
    const last = lastText(messages);
    if (first === "list three primes") {
      childStarted = Date.now();
      await new Promise(resolve => setTimeout(resolve, HOLD_MS));
      childDone = Date.now();
      return say("2, 3, 5");
    }
    if (last === "delegate") return call("subagent", { task: "list three primes" });
    if (last === SUBAGENT_STARTED) return say("delegated");
    if (last.startsWith("are you there")) return say("yes, the subagent still works");
    if (last.startsWith("[subagent-answer child:list three primes]")) return say("the subagent said 2, 3, 5");
    return say(`unexpected: ${last.slice(0, 120)}`);
  }, dir);
  const t0 = Date.now();
  assert.equal((await (await root.submit({ type: "input", content: "delegate" }, context)).wait(context)).status, "done");
  const delegated = Date.now() - t0;
  await until("the child to start", async () => childStarted > 0);
  const asked = Date.now();
  const steer = await (await root.submit({ type: "input", content: "are you there?", whenBusy: "steer" }, context)).wait(context);
  const answeredAt = Date.now();
  assert.equal(steer.status, "done");
  assert.equal(childDone, 0, "the steer was answered while the child still ran");
  await until("the child's answer", async () => inputs(await entriesOf(harness)).some(i => i.text.startsWith("[subagent-answer")) && (await entriesOf(harness)).at(-1)?.kind === "pi.assistant", HOLD_MS + 60_000);
  const entries = await entriesOf(harness);
  await harness.close(context);
  const answer = inputs(entries).find(i => i.text.startsWith("[subagent-answer"))!;
  assert.equal(answer.text, "[subagent-answer child:list three primes]\n\n2, 3, 5");
  assert.ok(delegated < 10_000, `the subagent call returned after ${delegated} ms`);
  assert.ok(answeredAt - asked < 10_000, `the steer was answered after ${answeredAt - asked} ms`);
  assert.ok(childDone - childStarted >= HOLD_MS - 50);
  process.stdout.write(`# subagent call ${delegated} ms, steer answered ${answeredAt - asked} ms, child ran ${childDone - childStarted} ms\n`);
});

test("a kill mid-cell gives that call interrupted, and the next call starts a fresh kernel with pi-rlm's reset note", { timeout: 180_000 }, async () => {
  const file = join(dir, "threads", "restart.sqlite");
  const marker = join(dir, "restart-marker");
  const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "rlm-worker.ts"), dir, file, marker], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => (stderr += String(chunk)));
  await until("the worker's sleeping cell", async () => existsSync(marker) && readFileSync(marker, "utf8").length > 0, 120_000).catch(error => { child.kill("SIGKILL"); throw new Error(`${error.message}\n${stderr}`); });
  const oldKernel = Number(readFileSync(marker, "utf8"));
  assert.ok(alive(oldKernel));
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("close", resolve));
  assert.ok(alive(oldKernel), "the relay keeps the kernel past the kill");

  const fresh = await DurableRlm.load(rlmOptions(dir));
  const { harness } = await openThread(file, "restart", fresh, ({ messages }) => {
    const last = lastText(messages);
    if (/interrupted/i.test(last)) return cell("import os\nprint(os.getpid())\nprint(x)");
    if (last.includes("NameError")) return say("x is gone");
    return say(`unexpected: ${last.slice(0, 200)}`);
  }, dir);
  await until("the run's end", async () => (await entriesOf(harness)).at(-1)?.kind === "pi.assistant" && results(await entriesOf(harness)).length >= 3, 120_000);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await fresh.shutdown();
  assert.equal(out[0]!.text.trim(), "x set");
  assert.ok(out[1]!.isError && /interrupted/i.test(out[1]!.text), out[1]!.text);
  assert.ok(out[2]!.text.startsWith(KERNEL_RESET), out[2]!.text);
  assert.match(out[2]!.text, /NameError: name 'x' is not defined/);
  const newKernel = Number(/\n(\d+)\n/.exec(out[2]!.text)?.[1]);
  assert.ok(newKernel && newKernel !== oldKernel);
  await until("the old kernel to end", async () => !alive(oldKernel), 15_000);
});
