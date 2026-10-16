import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { CHAT_MODE_ENTRY } from "../src/chat-guard.ts";
import { messageCheckPrelude, withMessageCheck } from "../src/message-limit-check.ts";
import { boardLimitClaims, lintOwnerReply } from "../src/shared/reply-lint.ts";

// c43 came back on 10-12 through text no lint read. Metal box owner (01a11d24) sent the Crawler VP (01a115e2) its canary lines at 04:40:20Z
// (13:40 KST) as an agent message; the Crawler VP wrote them into board step p23's note 5 s later and later named p118 after "metal's 75 MB/s
// step line". At 22:36 KST it told the owner the census cap was that line, and he answered "r u fucking kidding?" (22:37).
/** The agent message metal box owner sent the Crawler VP at 2026-10-12T04:40:20Z (agentmsg_64d3f6a6), verbatim. */
const METAL_0440 = "Metal: yes to a small prod canary after promote 7's read-back, as one release-owner write under v7c --act, stop write on any abort. Slot: 05:50Z (+15 at 06:05Z), right after the obs deploy; the staging engage 200 -> 400 step that held 05:50Z waits anyway (engage is paused for the GeoNode freezes and needs a clean hour first), so it moves to the first free slot after that clean hour.\nMETAL NET CLEAN stays a precondition; it is cheap and only rules out the box and its uplink, so it will not hold you up unless the box itself is the problem (it has been clean on every minute since 03:27Z). My +15 lines for the canary: IO avg300 under 5%, NVMe 15-min mean under 75 MB/s, backends within the per-role 215, and no supply hold. Your healthy line from geonode switch (failure rate after retries) is the proxy-side gate; I take it as you set it.";
/** The Crawler VP's plan_update note on p23 at 04:40:25Z, verbatim. */
const NOTE_P23 = "PROD PAUSE 4 since 03:21:43Z. Gateway fails about 1 in 5 calls; only us-09 takes our login. Metal OK'd a canary at 05:50Z after promote 7's read-back: history plus new 120/min, one REL write under v7c --act, stop write on any abort. Metal's +15 lines at 06:05Z: IO avg300 under 5%, NVMe 15-min mean under 75 MB/s, backends within 215, no supply hold. Proxy gate: my healthy line, set from geonode switch's numbers. Staging engage 400 moves after its clean hour.";
/** Board step p118's text on the Crawler VP board, verbatim. */
const STEP_P118 = "Fix: cut NVMe bytes written per new census read so the box carries 20k profiles/min under metal's 75 MB/s step line (about 0.22 MB per read; at the 10-09 figure of 1.24 MB the line sits near 3,600/min)";

test("c43: a threshold on a rate or size needs a measurement, a vendor limit or an incident in its own sentence", () => {
  for (const text of [
    "Stop the ramp if NVMe writes go above 150 MB/s.",
    "At +15 I need the NVMe 15-min mean <75 MB/s.",
    "Keep census under metal's 75 MB/s step line.",
    "Gate: writes under 75 MB/s, a safety line, while IO sits at 2% busy.",
  ]) assert.equal(lintOwnerReply(text).filter(finding => finding.kind === "unmeasured").length, 1, text);
  for (const text of [
    "The stop line is NVMe writes above 1,900 MB/s, the drive's rated sequential write.",
    "Hold census under 300 profiles a minute: above it the 10-12 incident put 429s on 33% of calls.",
    "Stop the ramp above 120 MB/s, where the NVMe ran 97% busy in the 10-09 load test.",
    "NVMe sat under 20 MB/s all day.",
    "The IO avg300 line is under 5%.",
  ]) assert.deepEqual(lintOwnerReply(text).filter(finding => finding.kind === "unmeasured"), [], text);
});

test("c43: board step text, notes and waitFor with an unbacked limit are refused; todos stay refused", () => {
  assert.equal(boardLimitClaims([{ op: "plan_update", id: "p23", note: NOTE_P23 }]).length, 1);
  assert.equal(boardLimitClaims([{ op: "plan_add", text: STEP_P118 }]).length, 1);
  assert.equal(boardLimitClaims([{ op: "plan_update", id: "p23", waitFor: "metal's +15 read: NVMe under 75 MB/s line" }]).length, 1);
  assert.equal(boardLimitClaims([{ op: "plan_set", items: [{ text: "Census ramp", children: [{ text: "canary", note: NOTE_P23 }] }] }]).length, 1);
  assert.deepEqual(boardLimitClaims([{ op: "plan_update", id: "p23", status: "done" }]), [], "a status change carries no text");
});

const fakePi = (dataDir: string) => {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, appendEntry() {},
    getActiveTools: () => [], setActiveTools() {}, getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined,
  };
  historyExtension(pi as never);
  const emit = async (name: string, event: unknown, ctx: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  return { tools, emit };
};

test("c43: the chat_board tool refuses step p118's text and writes nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "c43-step-"));
  const { tools } = fakePi(dataDir);
  const ctx = { sessionManager: { getSessionId: () => "s-c43" } };
  await assert.rejects(tools.get("chat_board")!.execute("c1", { ops: [{ op: "plan_add", text: STEP_P118 }] }, undefined, undefined, ctx),
    /todo or plan step states a limit with no evidence "[^"]*under metal's 75 MB\/s/);
  assert.equal(await new BoardStore(dataDir).read("s-c43"), null);
});

test("c43: the cells of a chat, of its subagent job and of a root job it registered get the message check once; other sessions' cells do not", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "c43-cell-"));
  await writeFile(join(dataDir, "chat-jobs.json"), JSON.stringify({ jobs: { "metal box owner": { chat: "Crawler VP", at: 1 } } }));
  const prelude = messageCheckPrelude(dataDir);
  const session = (entries: unknown[], header: unknown, name: string) => ({ sessionManager: { getHeader: () => header, getEntries: () => entries,
    getBranch: () => entries, getSessionId: () => `s-${name}`, getSessionName: () => name } });
  const cellOf = async (ctx: ReturnType<typeof session>) => {
    const pi = fakePi(dataDir);
    await pi.emit("session_start", {}, ctx);
    const cell = { toolName: "ipython", input: { code: "await agent_message.send(m, receiver_role='sibling', receiver_name='Crawler VP')" } };
    await pi.emit("tool_call", cell, ctx);
    return cell.input.code;
  };
  const chat = await cellOf(session([{ type: "custom", customType: CHAT_MODE_ENTRY }], {}, "Crawler VP"));
  assert.ok(chat.startsWith(prelude));
  assert.equal(withMessageCheck(chat, dataDir), undefined, "a second pass adds nothing");
  assert.ok((await cellOf(session([], {}, "metal box owner"))).startsWith(prelude), "metal box owner is a root job of the Crawler VP");
  assert.ok(!(await cellOf(session([], {}, "a plain thread"))).startsWith(prelude));
});

test("c43: after a kernel revive copies the wrapper, a send still reaches the live host_request (launch VP, 10-13)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c43-revive-"));
  await mkdir(join(dir, "rlm"));
  // The real rlm.host_request does a relative import, so a copy whose globals lost __package__ fails the way the revived kernel did.
  await writeFile(join(dir, "rlm", "__init__.py"), "sent = []\nasync def host_request(request_type, payload=None):\n    from . import repl\n" +
    "    sent.append(payload['message'])\n    return {'deliveryStatus': 'delivered'}\n");
  await writeFile(join(dir, "rlm", "repl.py"), "");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\nasync def send(message, *, receiver_role=None, receiver_name=None):\n" +
    "    return await host_request('agent_message.send', {'message': message, 'receiver_role': receiver_role, 'receiver_name': receiver_name})\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, sys, types, agent_message, rlm",
    "def revive(fn):",
    "    # What dill does with a function it pickles by value: the code, a copy of its globals without the module identity, copied closure cells.",
    "    g = {k: v for k, v in fn.__globals__.items() if k not in ('__name__', '__package__', '__spec__')}",
    "    cells = tuple(types.CellType(revive(c.cell_contents) if isinstance(c.cell_contents, types.FunctionType) else c.cell_contents) for c in fn.__closure__ or ())",
    "    return types.FunctionType(fn.__code__, g, fn.__name__, fn.__defaults__, cells or None)",
    "async def main(texts):",
    "    revived = revive(agent_message.host_request)",
    "    out = []",
    "    for text in texts:",
    "        try:",
    "            await revived('agent_message.send', {'message': text, 'receiver_role': 'parent'})",
    "            out.append('sent')",
    "        except Exception as error:",
    "            out.append(type(error).__name__)",
    "    print(json.dumps({'out': out, 'sent': rlm.sent}))",
    "asyncio.run(main(json.load(sys.stdin)))",
  ].join("\n");
  const clean = "Metal: NVMe writes read 18.4 MB/s at 23:09Z. No breach.";
  const run = spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, input: JSON.stringify([clean, METAL_0440]), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { out: ["sent", "sent"], sent: [clean, METAL_0440] });
});
