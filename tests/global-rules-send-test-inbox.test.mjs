import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Resend key and domain management and sends to Resend's test inboxes pass the send guard (c37, c113). These strings are only fed to the
// handler, never run. On 10-22 a slack-green key rotation was refused at POST api.resend.com/api-keys.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-test-inbox-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../components/global-rules/guard.ts");
const send = await import("../components/global-rules/send-guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const ipython = (code) => guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "ipython", input: { code } }, { cwd: root });
const bash = (command) => guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "bash", input: { command } }, { cwd: root });
const refused = (result, what) => {
  assert.equal(result?.block, true, what);
  assert.match(result.reason, /send guard/, what);
};

const TEST = '{"from":"Slack Green <noreply@slack.green>","to":["delivered@resend.dev"],"subject":"key rotation test","html":"<p>ok</p>"}';
const REAL = '{"from":"noreply@slack.green","to":["bob@example.com"],"subject":"hi"}';

test("Resend API key and domain management is no send", () => {
  for (const [method, path] of [["POST", "/api-keys"], ["DELETE", "/api-keys/k1"], ["POST", "/domains"], ["PATCH", "/domains/d1"], ["POST", "/domains/d1/verify"], ["DELETE", "/domains/d1"]]) {
    assert.equal(send.httpSend(method, `https://api.resend.com${path}`, '{"name":"slack-green-prod","permission":"sending_access"}'), null, `${method} ${path}`);
  }
  assert.equal(bash(`curl -X POST https://api.resend.com/api-keys -H 'Authorization: Bearer re_x' -d '{"name":"slack-green-prod"}'`), undefined);
  assert.equal(bash("curl -X DELETE https://api.resend.com/api-keys/k1 -H 'Authorization: Bearer re_x'"), undefined);
  assert.equal(ipython('import requests\nrequests.post("https://api.resend.com/api-keys", json={"name": "slack-green-prod"}, headers=h)'), undefined);
  assert.equal(ipython('import requests\nrequests.patch("https://api.resend.com/domains/d1", json={"click_tracking": False}, headers=h)'), undefined);
});

test("a send whose every to, cc and bcc recipient is at resend.dev passes, one message or a batch", () => {
  for (const body of [
    TEST,
    '{"from":"a@slack.green","to":"delivered@resend.dev","cc":["bounced@resend.dev"],"bcc":null,"subject":"x"}',
    '{"from":"a@slack.green","to":"Delivered <delivered+rotation@resend.dev>"}',
  ]) assert.equal(send.httpSend("POST", "https://api.resend.com/emails", body), null, body);
  assert.equal(send.httpSend("POST", "https://api.resend.com/emails/batch", '[{"from":"a@slack.green","to":["delivered@resend.dev"]},{"from":"a@slack.green","to":"complained@resend.dev"}]'), null);
  assert.equal(bash(`curl -X POST https://api.resend.com/emails -H 'Authorization: Bearer re_x' -H 'Content-Type: application/json' -d '${TEST}'`), undefined);
  assert.equal(bash("http POST https://api.resend.com/emails to=delivered@resend.dev subject=hi"), undefined);
  assert.equal(ipython("import requests\nrequests.post('https://api.resend.com/emails', json={'from': 'a@slack.green', 'to': ['delivered@resend.dev'], 'subject': 'x'}, headers=h)"), undefined);
  assert.equal(ipython("import resend\nresend.Emails.send({'from': 'a@slack.green', 'to': ['delivered@resend.dev'], 'subject': 'x', 'html': 'ok'})"), undefined);
  const script = join(root, "rotate.mjs");
  writeFileSync(script, "import { Resend } from 'resend';\nawait new Resend(process.env.RESEND_API_KEY).emails.send({ from: 'a@slack.green', to: ['delivered@resend.dev'], subject: 'x', html: 'ok' });\n");
  assert.equal(bash(`node ${script}`), undefined);
});

test("a send with any recipient outside resend.dev, or one it cannot read, is still refused", () => {
  for (const body of [
    REAL,
    '{"from":"a@slack.green","to":["delivered@resend.dev","bob@example.com"]}',
    '{"from":"a@slack.green","to":["delivered@resend.dev"],"cc":"bob@example.com"}',
    '{"from":"a@slack.green","to":["delivered@resend.dev"],"bcc":["bob@example.com"]}',
    '{"from":"a@slack.green","to":["delivered@resend.dev.example.com"]}',
    '{"from":"delivered@resend.dev","subject":"no recipient"}',
    "",
  ]) refused({ block: Boolean(send.httpSend("POST", "https://api.resend.com/emails", body)), reason: "send guard" }, body);
  refused({ block: Boolean(send.httpSend("POST", "https://api.resend.com/emails/batch", '[{"to":["delivered@resend.dev"]},{"to":["bob@example.com"]}]')), reason: "send guard" }, "mixed batch");
  refused({ block: Boolean(send.httpSend("POST", "https://api.resend.com/broadcasts/b1/send", "{}")), reason: "send guard" }, "broadcast send");
  refused(bash(`curl -X POST https://api.resend.com/emails -d '${REAL}'`), "curl real");
  refused(bash(`curl -X POST https://api.resend.com/emails/batch -d '[{"to":["delivered@resend.dev"]},{"to":["bob@example.com"]}]'`), "curl mixed batch");
  refused(bash("curl -X POST https://api.resend.com/emails -d @m.json"), "body from a file");
  refused(bash("http POST https://api.resend.com/emails to=bob@example.com subject=hi"), "httpie real");
  for (const code of [
    "import requests\nrequests.post('https://api.resend.com/emails', json={'to': ['delivered@resend.dev', who]}, headers=h)",
    "import requests\nrequests.post('https://api.resend.com/emails', json={'to': 'delivered@resend.dev' + other}, headers=h)",
    "import requests\nrequests.post('https://api.resend.com/emails', json={'to': f'{user}@resend.dev'}, headers=h)",
    "import requests\nrequests.post('https://api.resend.com/emails', json=payload, headers=h)",
    "import resend\nresend.Emails.send({'from': 'a@slack.green', 'to': ['delivered@resend.dev', 'bob@example.com']})",
    "import resend\nresend.Emails.send(params)",
    "import resend\nresend.Batch.send([{'to': ['delivered@resend.dev']}, {'to': ['bob@example.com']}])",
  ]) refused(ipython(code), code);
  const script = join(root, "send.mjs");
  writeFileSync(script, "import { Resend } from 'resend';\nawait new Resend(k).batch.send([{ to: ['delivered@resend.dev'] }, { to: [customer.email] }]);\n");
  refused(bash(`node ${script}`), "node batch with a customer");
  assert.ok(send.sendTarget("https://api.sendgrid.com/v3/mail/send", '{"to":["delivered@resend.dev"]}'), "resend.dev is only Resend's test inbox");
});
