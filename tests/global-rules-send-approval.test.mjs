import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The owner's ok on a For you todo lets one outside send through; anything less keeps the block.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-approval-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const data = join(root, "chat");
mkdirSync(join(data, "boards"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = data;
const guard = await import("../components/global-rules/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const CHAT = "01a00000-0000-7000-8000-0000000000c3";
const at = "2026-10-10T00:00:00.000Z";
const todo = (id, extra) => ({ id, text: "Send this reply to support@vendor.example?", choices: ["Send it", "Not yet"], from: "agent", at, ...extra });
writeFileSync(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], updatedAt: at, todos: [
  todo("t1", { done: true, reply: "Send it", answeredBy: "owner" }),
  todo("t2", { done: true, reply: "Not yet", answeredBy: "owner" }),
  todo("t3", { done: false }),
  todo("t4", { done: false, reply: "Send it", answeredBy: "owner" }),
  todo("t5", { done: true, reply: "Send it" }),
  todo("t6", { done: true, reply: "ok go ahead", answeredBy: "owner" }),
  todo("t7", { done: true, reply: "wait, not yet", answeredBy: "owner" }),
] }));

const SEND = "curl -sS -X POST https://acme.zendesk.com/api/v2/tickets/1.json -d '{\"ticket\":{\"comment\":{\"body\":\"hi\"}}}'";
const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });

test("a send without OWNER_OK is blocked and the reason says to draft and ask", () => {
  const result = call("bash", SEND);
  assert.equal(result?.block, true);
  assert.match(result.reason, /send guard/);
  assert.match(result.reason, /For you todo/);
  assert.match(result.reason, /OWNER_OK=<chat id>\/<todo id>/);
});

test("an approved todo lets the send through in bash and in an ipython cell", () => {
  assert.equal(call("bash", `OWNER_OK=${CHAT}/t1 ${SEND}`), undefined);
  assert.equal(call("ipython", `# OWNER_OK=${CHAT}/t1\nimport smtplib\nwith smtplib.SMTP("smtp.example.com") as s:\n    s.send_message(msg)`), undefined);
  assert.equal(call("bash", `OWNER_OK=${CHAT}/t6 ${SEND}`), undefined);
});

test("a todo that is held, open, unanswered by the owner, unknown or malformed keeps the block and says why", () => {
  for (const [id, why] of [["t2", /not a go/], ["t3", /not answered/], ["t4", /not checked off/], ["t5", /not answered/], ["t7", /not a go/], ["t99", /no todo t99/]]) {
    const result = call("bash", `OWNER_OK=${CHAT}/${id} ${SEND}`);
    assert.equal(result?.block, true, id);
    assert.match(result.reason, why, id);
  }
  assert.match(call("bash", `OWNER_OK=01a0ffff-0000-7000-8000-000000000000/t1 ${SEND}`).reason, /no readable board/);
});

test("OWNER_OK does not lift the other rules", () => {
  const result = call("bash", `OWNER_OK=${CHAT}/t1 grep -r foo ~/.prime`);
  assert.equal(result?.block, true);
  assert.match(result.reason, /grep guard/);
});

test("reading mail, drafting and GET requests pass without any token", () => {
  for (const [tool, text] of [
    ["bash", "curl -sS https://acme.zendesk.com/api/v2/tickets/1.json"],
    ["bash", "himalaya envelope list --folder INBOX"],
    ["bash", "cat draft.eml"],
    ["bash", "curl -sS -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts -d @draft.json"],
    ["ipython", "import requests\nr = requests.get('https://api.intercom.io/conversations/1')"],
    ["ipython", "from email.message import EmailMessage\nm = EmailMessage()\nm['To'] = 'support@vendor.example'\nopen('draft.eml', 'w').write(str(m))"],
    ["ipython", "await aside_browser.run(\"await page.getByRole('button', {name: 'Reply'}).click()\")"],
  ]) {
    assert.equal(call(tool, text), undefined, text);
  }
});
