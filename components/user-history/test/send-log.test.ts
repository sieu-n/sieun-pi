import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { findSends, readSends, sendLogPath, sessionOf } from "../../global-rules/send-log.ts";
import { backfill, formatSends } from "../src/send-log.ts";

// c37 reopened 10-12 21:41 KST: VP of CI (01a1180e) told the owner "no agent sent iWebFusion anything". Its job searched the wiki and
// Aside memory, and no record of agent sends existed, so it missed two 10-10 Gmail Send clicks through aside_browser. The fixtures are
// those transcripts' lines, verbatim minus thinking and usage: "Hello Ryan" at 05:25:31Z from check-in VP of CI 14:22 (01a12443), and
// "Hi Thomas" at 07:19:18Z from the job "iwf ticket chase" (01a1245e/sub-5bbdac13), each with the cells before it that opened the thread.
const FIXTURES = join(import.meta.dirname, "fixtures", "send-log");
const FIRST = "01a12443-6155-723b-8536-ce4c4edbb799";
const SECOND_CHAT = "01a1245e-d97d-73c4-9eff-977bd5e1c827";
const SECOND = "01a124aa-9fd6-75f8-b7e2-0e1c6f8f9c3d";

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "send-log-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "session-artifacts", SECOND_CHAT, "sub-5bbdac13"), { recursive: true });
  await copyFile(join(FIXTURES, `${FIRST}.jsonl`), join(dir, "sessions", `${FIRST}.jsonl`));
  await copyFile(join(FIXTURES, `${SECOND}.jsonl`), join(dir, "session-artifacts", SECOND_CHAT, "sub-5bbdac13", `${SECOND}.jsonl`));
  await writeFile(join(dir, "session-artifacts", SECOND_CHAT, "sub-5bbdac13", "semantic-edges.jsonl"), "{}\n");
  return dir;
}

test("send log: the backfill replays both 10-10 iWebFusion Send cells and a chat finds them by recipient", async () => {
  const dir = await agentDir();
  const log = join(dir, "browser-chat", "sends.jsonl");
  try {
    const added = await backfill({ agentDir: dir, since: "2026-10-08T00:00:00Z", logPath: log, until: "2026-10-12T15:00:00Z" });
    const found = findSends(readSends(log), { match: "iwebfusion" });
    assert.deepEqual(
      found.map((e) => [e.at, e.decision, e.chat, e.ownerOk]),
      [
        ["2026-10-10T05:25:31.893Z", "ran", FIRST, null],
        ["2026-10-10T07:19:18.515Z", "ran", SECOND_CHAT, null],
      ],
      "each Send click is one line, at the time its result came back, with no OWNER_OK",
    );
    assert.equal(added.length, 2, "the cells that only read or fill the reply are not sends");
    assert.equal(found[0]!.session, FIRST);
    assert.equal(found[1]!.session, `${SECOND_CHAT}/sub-5bbdac13/${SECOND}`);
    for (const e of found) {
      assert.match(e.target, /mail\.google\.com/);
      assert.match(e.target, /support@iwebfusion\.net/, "the recipient comes from the page the cells read before the click");
      assert.match(e.reason, /presses Send on a webmail page/);
      assert.match(e.where ?? "", /\.jsonl:\d+$/);
    }
    assert.match(found[0]!.where!, new RegExp(`${FIRST}\\.jsonl:6$`), "the line of the Send cell in the fixture");
    assert.match(formatSends(found), /^2 outside sends in .*: 2 ran\.\n2026-10-10T05:25:31\.893Z ran transcript chat=01a12443/);
    assert.equal(findSends(readSends(log), { match: "iwebfusion", since: "2026-10-10T06:00:00Z" }).length, 1);
    assert.equal(findSends(readSends(log), { chat: SECOND_CHAT }).length, 1);

    const again = await backfill({ agentDir: dir, since: "2026-10-08T00:00:00Z", logPath: log, until: "2026-10-12T15:00:00Z" });
    assert.deepEqual(again, [], "a second backfill adds nothing");
    assert.equal(readSends(log).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send log: the backfill stops at the first live guard line and skips transcripts older than since", async () => {
  const dir = await agentDir();
  const log = join(dir, "browser-chat", "sends.jsonl");
  try {
    await mkdir(join(dir, "browser-chat"), { recursive: true });
    await writeFile(log, `${JSON.stringify({ at: "2026-10-10T06:00:00.000Z", decision: "refused", layer: "aside-browser", chat: null, session: null, target: "x", reason: "y", ownerOk: null })}\n`);
    const added = await backfill({ agentDir: dir, since: "2026-10-08T00:00:00Z", logPath: log });
    assert.deepEqual(added.map((e) => e.at), ["2026-10-10T05:25:31.893Z"], "the 07:19Z send is after the live log starts, so the guards own it");
    const old = new Date("2026-10-01T00:00:00Z");
    await utimes(join(dir, "sessions", `${FIRST}.jsonl`), old, old);
    const fresh = await backfill({ agentDir: dir, since: "2026-10-08T00:00:00Z", logPath: join(dir, "other.jsonl") });
    assert.deepEqual(fresh.map((e) => e.at), ["2026-10-10T07:19:18.515Z"], "a transcript last written before since is not read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send log: the tool_call guard and the kernel check write one line per send they refuse or allow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "send-guard-log-"));
  const saved = { ...process.env };
  const chat = "01a00000-0000-7000-8000-000000000001";
  try {
    process.env.GLOBAL_RULES_LOG = join(dir, "global-rules.log");
    process.env.GLOBAL_RULES_SEND_LOG = join(dir, "sends.jsonl");
    process.env.AGENT_CHAT_DATA_DIR = join(dir, "chat");
    await mkdir(join(dir, "chat", "boards"), { recursive: true });
    await writeFile(join(dir, "chat", "boards", `${chat}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], scratch: [], updatedAt: "2026-10-12T00:00:00Z", todos: [
      { id: "t1", text: "Send this reply to support@vendor.example?", done: true, choices: ["Send it", "Not yet"], from: "agent", at: "2026-10-12T00:00:00Z", reply: "Send it", answeredBy: "owner" },
    ] }));
    assert.equal(sendLogPath(), join(dir, "sends.jsonl"));
    // Loaded by URL so this package's stricter tsconfig does not type-check global-rules, which the root tsconfig owns.
    const guard = (await import(pathToFileURL(join(import.meta.dirname, "..", "..", "global-rules", "guard.ts")).href)) as {
      onToolCall(event: unknown, ctx: unknown): { block: boolean } | undefined;
    };
    const check = (await import(pathToFileURL(join(import.meta.dirname, "..", "..", "global-rules", "send-check.ts")).href)) as {
      judgeCheck(check: unknown, record?: boolean): { block: boolean };
    };
    const ctx = { cwd: dir, sessionManager: { getSessionFile: () => `/u/.prime/agent/session-artifacts/${chat}/sub-aa/${"01a2"}.jsonl` } };
    const send = "curl -X POST https://api.sendgrid.com/v3/mail/send -d '{\"to\":\"support@vendor.example\"}'";
    assert.equal(guard.onToolCall({ toolName: "bash", input: { command: send } }, ctx)?.block, true);
    assert.equal(guard.onToolCall({ toolName: "bash", input: { command: `OWNER_OK=${chat}/t1 ${send}` } }, ctx), undefined);
    assert.equal(guard.onToolCall({ toolName: "bash", input: { command: "curl https://api.sendgrid.com/v3/stats" } }, ctx), undefined, "a read is not a send");
    process.env.RLM_SESSION_DIR = `/u/.prime/agent/session-artifacts/${chat}/sub-bb`;
    assert.equal(check.judgeCheck({ kind: "http", method: "POST", url: "https://api.sendgrid.com/v3/mail/send", approval: "" }, true).block, true);
    assert.equal(check.judgeCheck({ kind: "http", method: "POST", url: "https://api.sendgrid.com/v3/mail/send", approval: `# OWNER_OK=${chat}/t1` }, true).block, false);
    assert.equal(check.judgeCheck({ kind: "http", method: "POST", url: "https://api.sendgrid.com/v3/mail/send", approval: "" }).block, true, "only the kernel's CLI run records");
    const lines = readSends(join(dir, "sends.jsonl"));
    assert.deepEqual(
      lines.map((e) => [e.layer, e.decision, e.session, e.ownerOk]),
      [
        ["tool_call", "refused", `${chat}/sub-aa/01a2`, null],
        ["tool_call", "allowed", `${chat}/sub-aa/01a2`, `${chat}/t1`],
        ["kernel", "refused", `${chat}/sub-bb`, null],
        ["kernel", "allowed", `${chat}/sub-bb`, `${chat}/t1`],
      ],
    );
    for (const line of lines) {
      assert.equal(line.chat, chat);
      assert.match(line.target, /api\.sendgrid\.com\/v3\/mail\/send/);
      assert.doesNotMatch(line.reason, /For you todo|refused, because/, "the reason is the guard's because-clause, not its help text");
    }
    // An allowed ipython cell is logged by the kernel when the send runs, not twice.
    assert.equal(guard.onToolCall({ toolName: "ipython", input: { code: `# OWNER_OK=${chat}/t1\nimport requests\nrequests.post("https://api.sendgrid.com/v3/mail/send", json={})` } }, ctx), undefined);
    assert.equal(readSends(join(dir, "sends.jsonl")).length, 4);
  } finally {
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("send log: the backfill counts a browser call that passed owner_ok, with the token an earlier cell set", async () => {
  // 10-12 06:41Z GeoNode: the owner-approved note went out by a coordinate click in the Intercom frame, which the page check cannot read.
  const dir = await mkdtemp(join(tmpdir(), "send-log-ok-"));
  const chat = "01a115e2-9544-7204-b8db-8ce4d5319048";
  const line = (o: unknown) => JSON.stringify(o);
  const call = (id: string, at: string, code: string) => line({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }] } });
  const result = (id: string, at: string, text: string) => line({ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false } });
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${chat}.jsonl`), [
      line({ type: "session", id: chat, cwd: dir }),
      call("a", "2026-10-12T06:30:00.000Z", `tok = '${chat}/t22'\nawait aside_browser.open_tab('https://app.geonode.com/dashboard')`),
      result("a", "2026-10-12T06:30:01.000Z", "ok"),
      call("b", "2026-10-12T06:41:16.486Z", `print(await aside_browser.run("await page.mouse.click(1378,775); await sleep(4000); return 'sent'", owner_ok=tok))`),
      result("b", "2026-10-12T06:41:20.894Z", "sent"),
      call("c", "2026-10-12T06:42:00.000Z", `print(await aside_browser.run("await page.mouse.click(1,2)", owner_ok=None))`),
      result("c", "2026-10-12T06:42:01.000Z", "ok"),
    ].join("\n") + "\n");
    const added = await backfill({ agentDir: dir, since: "2026-10-08T00:00:00Z", logPath: join(dir, "sends.jsonl"), until: "2026-10-13T00:00:00Z" });
    assert.deepEqual(added.map((e) => [e.at, e.decision, e.ownerOk, e.target]), [["2026-10-12T06:41:20.894Z", "ran", `${chat}/t22`, "https://app.geonode.com/dashboard"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send log: a session path names its chat and session", () => {
  assert.deepEqual(sessionOf("/u/.prime/agent/sessions/01a1.jsonl"), { chat: "01a1", session: "01a1" });
  assert.deepEqual(sessionOf("/u/.prime/agent/session-artifacts/01a1/sub-5b"), { chat: "01a1", session: "01a1/sub-5b" });
  assert.deepEqual(sessionOf(undefined), { chat: null, session: null });
});
