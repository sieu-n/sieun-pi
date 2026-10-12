import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { CHAT_MODE_ENTRY } from "../src/chat-guard.ts";
import { jobNames } from "../src/limit-names.ts";
import { checkMessage, messageCheckPrelude, withMessageCheck } from "../src/message-limit-check.ts";
import { boardLimitClaims, lintOwnerReply, messageLimitRefusal } from "../src/shared/reply-lint.ts";

// c43 came back on 10-12 through text no lint read. Metal box owner (01a11d24) sent the Crawler VP (01a115e2) its canary lines at 04:40:20Z
// (13:40 KST) as an agent message; the Crawler VP wrote them into board step p23's note 5 s later and later named p118 after "metal's 75 MB/s
// step line". At 22:36 KST it told the owner the census cap was that line, and he answered "r u fucking kidding?" (22:37).
/** The agent message metal box owner sent the Crawler VP at 2026-10-12T04:40:20Z (agentmsg_64d3f6a6), verbatim. */
const METAL_0440 = "Metal: yes to a small prod canary after promote 7's read-back, as one release-owner write under v7c --act, stop write on any abort. Slot: 05:50Z (+15 at 06:05Z), right after the obs deploy; the staging engage 200 -> 400 step that held 05:50Z waits anyway (engage is paused for the GeoNode freezes and needs a clean hour first), so it moves to the first free slot after that clean hour.\nMETAL NET CLEAN stays a precondition; it is cheap and only rules out the box and its uplink, so it will not hold you up unless the box itself is the problem (it has been clean on every minute since 03:27Z). My +15 lines for the canary: IO avg300 under 5%, NVMe 15-min mean under 75 MB/s, backends within the per-role 215, and no supply hold. Your healthy line from geonode switch (failure rate after retries) is the proxy-side gate; I take it as you set it.";
/** The Crawler VP's plan_update note on p23 at 04:40:25Z, verbatim. */
const NOTE_P23 = "PROD PAUSE 4 since 03:21:43Z. Gateway fails about 1 in 5 calls; only us-09 takes our login. Metal OK'd a canary at 05:50Z after promote 7's read-back: history plus new 120/min, one REL write under v7c --act, stop write on any abort. Metal's +15 lines at 06:05Z: IO avg300 under 5%, NVMe 15-min mean under 75 MB/s, backends within 215, no supply hold. Proxy gate: my healthy line, set from geonode switch's numbers. Staging engage 400 moves after its clean hour.";
/** Board step p118's text on the Crawler VP board, verbatim. */
const STEP_P118 = "Fix: cut NVMe bytes written per new census read so the box carries 20k profiles/min under metal's 75 MB/s step line (about 0.22 MB per read; at the 10-09 figure of 1.24 MB the line sits near 3,600/min)";
/** The Crawler VP to its job tiktok shop at 2026-10-10T03:40:30Z, verbatim: an order with a threshold and no line word. */
const ORDER_1010 = "Crawler ops to TikTok Shop: metal says your gates are fine and adds two:\n1. Signer: use only the prod tiktok-signer as it runs today, with no signer replicas on prod. Replicas need metal's approval file apps/infra/metal/approvals/signer-replicas-prod, and metal creates it only after it reviews the staging native receipt, which it has not received yet. At +15, read the signer's anon memory: STOP (pause the lane) above 400 MiB; the cap is 512m.\n2. Add the NVMe write 15-min mean under 75 MB/s to the +15 read, the same as the census steps.\nIf you owe metal that staging receipt, send it directly. No reply needed.";
/** The ops guy to this chat at 2026-10-10T07:12:38Z, verbatim: readings against stated caps. */
const OPS_READING = "Ops guy: the \"local dev uptime\" duty is live in this chat (d1, every 10 min) and its first scheduled run at 14:46 KST met all 11 targets: wiki :5176 605 ms, search :5174 354 ms, Convex 127.0.0.1:3210/version 85 ms, crawler localhost:8787/health 110 ms, wiki pm2 tree 1438 MB (cap 4096), 0 restarts. It reuses probe/treePids/footprintMb/restartsSince from your llm-wiki.ts (sieun-pi efa7899, local, not pushed). Please delete your llm-wiki 10-min duty (d2) now. After that I will move those 4 helpers into local-dev-uptime.ts and delete llm-wiki.ts, llm-wiki.duty.json and its test, unless you want to keep them for your daily wiki cleanup duty; tell me only in that case. No other reply needed.";
/** The Crawler VP to metal box owner at 2026-10-12T11:30:05Z, verbatim: "instagram 401 ceiling" is a job. */
const SCAN_1130 = "From Crawler ops, the instagram 401 ceiling scan ran once under your go: 391 ms, 11,514,630 rows read (332.7 MB), 33.8 MB memory, max_threads 4 (from system.query_log). A note from the job: instagram_census_reads sorts by (census_id, lane, issued_at) in one partition 202610, so even a 1-hour window reads all 11.5M rows. Every census_reads query costs this same full scan. A1's snapshot tables replace it; until then, treat any query on it as a full scan.";

test("c43: the 04:40Z metal message is refused for its 75 MB/s line", () => {
  const refusal = messageLimitRefusal(METAL_0440);
  assert.match(refusal ?? "", /^Refused, not sent: this agent message states a limit with no evidence "[^"]*under 75 MB\/s/);
  assert.equal(messageLimitRefusal("Metal: NVMe writes read 18.4 MB/s at 23:09Z and IO pressure 0.14% (5-min). No breach."), null, "a reading is no limit");
});

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
  assert.deepEqual(boardLimitClaims([{ op: "plan_update", id: "p23", status: "done" }, { op: "scratch_add", text: NOTE_P23 }]), [],
    "a status change carries no text, and scratch notes record what others said");
});

test("c43: an order or condition with a threshold is a limit even with no line word (the 10-10 03:40Z order)", () => {
  assert.match(messageLimitRefusal(ORDER_1010) ?? "", /no evidence "NVMe write 15-min mean under 75 MB\/s/);
  for (const text of ["Pause the lane if writes go over 150 MB/s.", "Census must stay under 2,000 profiles a minute."]) assert.notEqual(messageLimitRefusal(text), null, text);
  assert.equal(messageLimitRefusal("NVMe sat under 20 MB/s all day, and IO avg300 read 0.4%."), null);
});

test("c43: a reading against a stated cap is no claim; a new cap still is", () => {
  assert.equal(messageLimitRefusal(OPS_READING), null);
  for (const text of ["dev-guard already restarted it at 06:43Z, when it hit 4457 MB against the 4096 cap.",
    "Mac swap is 21.4 of 22.5 GB used, over ops guy's 16 GiB cap.", "With 1.69 GB, the estimate is about 4.0 GiB, under the 6 GiB cap."]) assert.equal(messageLimitRefusal(text), null, text);
  for (const text of ["The 2,100 cap is metal's 75 MB/s disk-write line.", "Prod caps: 80 jobs/s, NVMe under 75 MB/s."]) assert.notEqual(messageLimitRefusal(text), null, text);
});

test("c43: a job name with a cap word in it is a name: the board's jobs and chat-jobs.json give the names", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "c43-names-"));
  await mkdir(join(dataDir, "boards"));
  await writeFile(join(dataDir, "boards", "crawler.json"), JSON.stringify({ v: 2, plan: [{ id: "p1", text: "A/B", children: [{ id: "p2", text: "scan", job: "instagram 401 ceiling", children: [] }] }] }));
  await writeFile(join(dataDir, "chat-jobs.json"), JSON.stringify({ jobs: { "metal box owner": { chat: "Crawler VP" }, "01a12195-9f12-757f-8759-8d90bdd58fca": { chat: "SEO guy" } } }));
  assert.deepEqual((await jobNames(dataDir)).sort(), ["instagram 401 ceiling", "metal box owner"]);
  assert.notEqual(messageLimitRefusal(SCAN_1130), null, "without the names the job reads as a ceiling");
  assert.equal(await checkMessage(SCAN_1130, dataDir), null);
  assert.match(await checkMessage(METAL_0440, dataDir) ?? "", /under 75 MB\/s/);
});

test("c43: a named line with what it carries is a claim; a reading of a cap, the owner's own number and a line that is gone are not", () => {
  // census write cuts to the Crawler VP, 10-12: the job's capacity claims that rested on the 75 MB/s line.
  for (const text of ["Done, and the final number holds: a new census read writes 1.69 MB and a history read about 0.35 MB, so the 75 MB/s line carries about 2,100 new/min and 20k/min needs an 8x cut to 0.22 MB.",
    "That puts the 75 MB/s line near 2,200 new/min, and 20k/min would need about 580 MB/s, so we need an 8x cut to reach 0.22 MB."]) assert.notEqual(messageLimitRefusal(text), null, text);
  for (const text of ["| Wiki memory | 1062 MB of the 4096 MB cap | | pm2 restarts | 0 for the wiki, 0 for search |",
    "- The 2/day cap is the owner's number, not a measurement.", "Update from the VP: the owner overruled the 75 MB/s line (NVMe does 3,500-14,000 MB/s), so it no longer gates census.",
    "From Crawler ops: thanks, 1.69 MB holds."]) assert.equal(messageLimitRefusal(text), null, text);
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

test("c43: in the kernel, agent_message.send of the 04:40Z message raises LimitRefused and the host gets nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c43-kernel-"));
  await writeFile(join(dir, "rlm.py"), "sent = []\nasync def host_request(request_type, payload=None):\n    sent.append((request_type, payload))\n    return {'deliveryStatus': 'delivered'}\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\nasync def send(message, *, receiver_role=None, receiver_name=None):\n" +
    "    return await host_request('agent_message.send', {'message': message, 'receiver_role': receiver_role, 'receiver_name': receiver_name})\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, sys, agent_message, rlm",
    "async def main(texts):",
    "    out = []",
    "    for text in texts:",
    "        try:",
    "            await agent_message.send(text, receiver_role='sibling', receiver_name='Crawler VP')",
    "            out.append('sent')",
    "        except Exception as error:",
    "            out.append(type(error).__name__ + ': ' + str(error))",
    "    print(json.dumps({'out': out, 'sent': [p['message'] for _, p in rlm.sent]}))",
    "asyncio.run(main(json.load(sys.stdin)))",
  ].join("\n");
  const clean = "Metal: NVMe writes read 18.4 MB/s at 23:09Z. No breach.";
  const run = spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, input: JSON.stringify([METAL_0440, clean]), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { out: string[]; sent: string[] };
  assert.match(result.out[0]!, /^LimitRefused: Refused, not sent: this agent message states a limit with no evidence/);
  assert.deepEqual(result.out.slice(1), ["sent"]);
  assert.deepEqual(result.sent, [clean]);
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
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { out: ["sent", "LimitRefused"], sent: [clean] });
});
