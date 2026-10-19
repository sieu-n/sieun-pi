import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Send paths from the c37 gap table (2204-c37-send-guards/data/map/gap-table.md) that the tool_call guard must judge.
// Each test names its gap rows. These strings are only fed to the handler; nothing here runs them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-gaps-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const data = join(root, "chat");
mkdirSync(join(data, "boards"), { recursive: true });
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = data;
const guard = await import("../components/global-rules/guard.ts");
const cua = await import("../components/global-rules/cua-guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const CHAT = "01a00000-0000-7000-8000-0000000000c5";
const at = "2026-10-10T00:00:00.000Z";
writeFileSync(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], updatedAt: at, todos: [
  { id: "t1", text: "Post this comment on vercel/next.js?", choices: ["Send it", "Not yet"], from: "agent", at, done: true, reply: "Send it", answeredBy: "owner" },
  { id: "t2", text: "Post this comment on vercel/next.js?", choices: ["Send it", "Not yet"], from: "agent", at, done: true, reply: "Not yet", answeredBy: "owner" },
] }));

// Helper scripts that a shell command runs by path (http-20, http-21, osa-4); the guard has to read them from the cwd.
writeFileSync(join(work, "send-helper.mjs"), "await fetch('https://api.resend.com/emails', { method: 'POST', body: JSON.stringify({ to: 'bob@example.com' }) });\n");
writeFileSync(join(work, "read-helper.mjs"), "const r = await fetch('https://api.github.com/repos/sieu-n/sieun-pi');\nconsole.log(await r.text());\n");
writeFileSync(join(work, "send_mail.py"), "import requests\nrequests.post('https://api.resend.com/emails', json={'to': 'bob@example.com'})\n");
writeFileSync(join(work, "read_mail.py"), "import requests\nprint(requests.get('https://api.resend.com/emails/abc').json())\n");
writeFileSync(join(work, "send_mail.applescript"), 'tell application "Mail"\n  set m to make new outgoing message with properties {subject:"hi", content:"x"}\n  send m\nend tell\n');
writeFileSync(join(work, "list_mail.applescript"), 'tell application "Mail" to get subject of messages of inbox\n');

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text, cwd = root) => guard.onToolCall(event(toolName, text), { cwd });

function blocked(toolName, texts, cwd = root) {
  for (const text of texts) {
    const result = call(toolName, text, cwd);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /send guard/, `${toolName}: ${text}`);
  }
}

function allowed(toolName, texts, cwd = root) {
  for (const text of texts) assert.equal(call(toolName, text, cwd), undefined, `${toolName}: ${text}`);
}

test("gh-1..gh-5: gh issue and pr writes on a repo the owner does not own are blocked", () => {
  blocked("bash", [
    "gh issue create -R vercel/next.js -t 'Bug' -b 'Repro attached'",
    "gh issue comment 123 -R vercel/next.js -b 'Any update?'",
    "gh pr create -R get-convex/convex-backend --title fix --body 'small fix'",
    "gh pr comment 45 -R get-convex/convex-backend -b 'LGTM'",
    "gh pr review 45 -R get-convex/convex-backend --comment -b 'nit'",
    "gh issue comment 123 --repo vercel/next.js --body hi",
    "gh issue comment https://github.com/vercel/next.js/issues/123 -b hi",
    "cd /tmp && gh pr comment 45 -R get-convex/convex-backend -b ok",
  ]);
});

test("gh-6..gh-8: gh api writes to an outside repo and graphql mutations are blocked", () => {
  blocked("bash", [
    "gh api -X POST repos/vercel/next.js/issues/123/comments -f body='ping'",
    "gh api repos/vercel/next.js/issues -f title=Bug -f body=hi",
    "gh api --method POST /repos/vercel/next.js/issues/123/comments -F body=@reply.md",
    `gh api graphql -f query='mutation{addDiscussionComment(input:{discussionId:"D_1",body:"hi"}){comment{id}}}'`,
  ]);
});

test("gh-9: a gh outside-repo comment run through bash() from an ipython cell is blocked", () => {
  blocked("ipython", [
    "await bash('gh issue comment 123 -R vercel/next.js -b hi')",
    "h = bash(\"gh pr review 45 -R get-convex/convex-backend --comment -b 'nit'\")",
  ]);
});

test("gh writes on sieu-n and virev-ai repos and gh reads stay allowed", () => {
  allowed("bash", [
    "gh issue create -R sieu-n/x -t 'Bug' -b 'body'",
    "gh pr comment 3 -R virev-ai/x -b 'done'",
    "gh issue comment 7 -R sieu-n/sieun-pi -b hi",
    "gh api -X POST repos/sieu-n/sieun-pi/issues/1/comments -f body=hi",
    "gh issue view 123 -R vercel/next.js",
    "gh pr list -R get-convex/convex-backend",
    "gh api repos/vercel/next.js/issues/123/comments",
    "gh api graphql -f query='query{viewer{login}}'",
  ]);
});

test("an approved OWNER_OK lets one gh outside-repo comment through, and a held todo keeps the block", () => {
  const send = "gh issue comment 123 -R vercel/next.js -b 'Any update?'";
  assert.equal(call("bash", `OWNER_OK=${CHAT}/t1 ${send}`), undefined);
  const held = call("bash", `OWNER_OK=${CHAT}/t2 ${send}`);
  assert.equal(held?.block, true);
  assert.match(held.reason, /not a go/);
});

test("http-7 and bash-2: a mail API URL held in a shell variable or run through eval is blocked", () => {
  blocked("bash", [
    `URL=https://api.resend.com/emails; curl -X POST "$URL" -d @m.json`,
    `URL=https://api.resend.com/emails && curl -X POST $URL -d @m.json`,
    `CMD='curl -X POST https://api.resend.com/emails -d @m.json'; eval "$CMD"`,
  ]);
});

test("http-11..13 and other outside chat or social APIs are blocked: Discord, Telegram, Twilio, WhatsApp, Teams, LinkedIn, X", () => {
  blocked("bash", [
    `curl -H 'Content-Type: application/json' -d '{"content":"hi"}' https://discord.com/api/webhooks/1/abc`,
    "curl -X POST https://discordapp.com/api/channels/1/messages -d @m.json",
    "curl -d chat_id=123 -d text=hi https://api.telegram.org/bot$TOKEN/sendMessage",
    "curl -X POST https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json -d To=+1555 -d Body=hi -u $SID:$TOK",
    `curl -X POST https://graph.facebook.com/v19.0/123/messages -d '{"messaging_product":"whatsapp","to":"1555"}'`,
    `curl -H 'Content-Type: application/json' -d '{"text":"hi"}' https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def`,
    "curl -X POST https://api.linkedin.com/v2/ugcPosts -d @post.json",
    `curl -X POST https://api.twitter.com/2/tweets -d '{"text":"hi"}'`,
    `curl -X POST https://api.x.com/2/tweets -d '{"text":"hi"}'`,
  ]);
});

test("http-9 and http-10: Slack API and Slack webhook posts stay allowed (the owner's own workspaces)", () => {
  allowed("bash", [
    `curl -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_TOKEN" -d channel=C1 -d text=hi`,
    `curl -X POST -d '{"text":"hi"}' https://hooks.slack.com/services/T0/B0/XXX`,
  ]);
});

test("http-19 and http-22, smtp-2: node -e and python3 -c bodies that send are blocked", () => {
  blocked("bash", [
    `node -e "fetch('https://api.resend.com/emails',{method:'POST',body:'{}'})"`,
    `python3 -c "import requests; requests.post('https://api.resend.com/emails', json={})"`,
    `python -c "import httpx; httpx.post('https://api.sendgrid.com/v3/mail/send', json={})"`,
    `python3 -c "import smtplib; s=smtplib.SMTP('smtp.gmail.com',587); s.sendmail('a@x','b@y','hi')"`,
  ]);
  allowed("bash", [
    `node -e "console.log(1 + 1)"`,
    `python3 -c "import requests; print(requests.get('https://api.resend.com/emails/abc').status_code)"`,
  ]);
});

test("http-20 and http-21: node and python helper scripts that send are blocked, read-only helpers pass", () => {
  blocked("bash", ["node send-helper.mjs", "node ./send-helper.mjs", "python3 send_mail.py --to bob@example.com", "uv run python send_mail.py"], work);
  blocked("bash", [`node ${join(work, "send-helper.mjs")}`], root);
  blocked("ipython", ["await bash('python3 send_mail.py --to bob@example.com')"], work);
  allowed("bash", ["node read-helper.mjs", "python3 read_mail.py"], work);
});

test("osa-2..osa-4: Messages.app send, JXA Mail send and a Mail send script file are blocked; osa-6 open mailto: is allowed", () => {
  blocked("bash", [
    `osascript -e 'tell application "Messages" to send "hi" to buddy "+15551234"'`,
    `osascript -e 'tell application "Messages" to send "hi" to participant "+15551234" of account 1'`,
    `osascript -l JavaScript -e 'Application("Mail").outgoingMessages[0].send()'`,
    "osascript send_mail.applescript",
  ], work);
  allowed("bash", [
    "open 'mailto:bob@example.com?subject=hi&body=x'",
    "osascript list_mail.applescript",
    `osascript -e 'tell application "Messages" to get name of every chat'`,
  ], work);
});

test("oth-1..oth-4: Stripe invoice send, Clerk invitations and vercel teams invite are blocked; reads pass", () => {
  blocked("bash", [
    "stripe invoices send in_123",
    "stripe post /v1/invoices/in_123/send",
    `curl -X POST https://api.clerk.com/v1/invitations -H "Authorization: Bearer $CLERK_SECRET_KEY" -d '{"email_address":"x@y.com"}'`,
    "vercel teams invite bob@example.com",
  ]);
  allowed("bash", [
    "stripe invoices list --limit 3",
    "stripe get /v1/invoices/in_123",
    "curl https://api.clerk.com/v1/invitations -H \"Authorization: Bearer $CLERK_SECRET_KEY\"",
    "vercel teams ls",
  ]);
});

test("be-1..be-4: our own email send entry points through convex run or the HTTP route are blocked", () => {
  blocked("bash", [
    `npx convex run search/campaigns/scheduler:sendEmail '{"emailId":"x"}' --prod`,
    `npx convex run search/mcpOutreach:emailSend '{"userId":"u","to":"creator@x.com"}'`,
    "npx convex run search/support/chatEmail:notifyEmail '{}'",
    `curl -X POST https://example.convex.site/api/mcp/outreach/email/send -H "x-secret: $S" -d @send.json`,
  ]);
  allowed("bash", [
    "npx convex run emails:listDrafts '{}'",
    "npx convex run search/campaigns/scheduler:listQueued '{}'",
    "curl -X POST http://localhost:8788/api/mcp/outreach/email/send -d @send.json",
    "curl -X POST http://127.0.0.1:3000/email/send -d @send.json",
  ]);
});

// A stand-in for this machine's Convex and its Vent, in a child process because the guard reads it with a blocking curl. The admin key picks
// the world: "mock" has a mock-mode Vent and an empty searchSmtpConnections table, "real" a real-mode Vent, "smtp" a mock-mode Vent and
// one SMTP sender row, and "notable" a mock-mode Vent and no searchSmtpConnections table.
const FAKE_LOCAL = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const base = "http://127.0.0.1:" + server.address().port;
    const key = String(req.headers.authorization || "").replace(/^Convex /, "");
    const path = raw ? JSON.parse(raw).path : "";
    const done = (page) => ({ status: "success", value: { page, isDone: true, continueCursor: "end" } });
    const tables = [{ name: "searchContacts" }, ...(key === "notable" ? [] : [{ name: "searchSmtpConnections" }])];
    const smtp = key === "smtp" ? [{ _id: "s1", host: "smtp.example.com", port: 587 }] : [];
    const body = req.url === "/vent-mock/healthz" ? { ok: true, mode: "mock" } : req.url === "/vent-real/healthz" ? { ok: true, mode: "real" }
      : req.url !== "/api/query" ? null
      : path === "_system/cli/queryEnvironmentVariables:get" ? { status: "success", value: { name: "VENT_URL", value: base + (key === "real" ? "/vent-real" : "/vent-mock") } }
      : path === "_system/cli/tables" ? done(tables)
      : path === "_system/cli/tableData" ? done(smtp) : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

test("a convex run send against this machine's Convex passes only when its Vent answers mode mock and it holds no SMTP sender", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", FAKE_LOCAL], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
  const local = `http://127.0.0.1:${port}`;
  const send = "npx convex run search/senders/resendDomainActions:sendTestEmail '{\"toEmail\":\"delivered@resend.dev\"}'";
  allowed("bash", [`${send} --url ${local} --admin-key mock`, `${send} --url=${local}/ --admin-key=mock`]);
  blocked("bash", [
    `${send} --url ${local} --admin-key real`,
    `${send} --url ${local} --admin-key smtp`,
    `${send} --url ${local} --admin-key notable`,
    `${send} --url https://tremendous-eel-825.convex.cloud --admin-key mock`,
    `${send} --url ${local} --admin-key mock --prod`,
    `${send} --deployment tremendous-eel-825`,
    `${send} --url http://127.0.0.1:1 --admin-key mock`,
    send,
  ]);
  const repo = join(root, "convex-repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, ".env.local"), `CONVEX_SELF_HOSTED_URL=${local}\nCONVEX_SELF_HOSTED_ADMIN_KEY=mock\n`);
  allowed("bash", [send, `CONVEX_SELF_HOSTED_URL=${local} ${send}`], repo);
  blocked("bash", [
    `CONVEX_SELF_HOSTED_ADMIN_KEY=real ${send}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=smtp ${send}`,
    `CONVEX_DEPLOYMENT=prod:tremendous-eel-825 ${send}`,
    `env CONVEX_DEPLOY_KEY=prod:x ${send}`,
    `CONVEX_SELF_HOSTED_URL=https://convex.example.com ${send}`,
    `cd sub && ${send}`,
  ], repo);
});

test("cli-2 and cli-3: an aside agent prompt that sends is blocked with no exec word or with a flag before exec", () => {
  blocked("bash", [
    "aside 'Reply to the GeoNode support ticket and send it'",
    "aside -m openai/gpt-5.6-sol exec 'Reply to the vendor support email and send it'",
  ]);
  allowed("bash", [
    "aside 'Read the GeoNode support ticket and summarize it. Do not send anything.'",
    "aside -m openai/gpt-5.6-sol exec 'Summarize my open tabs'",
  ]);
});

test("cuash-2: a cua-driver call whose JSON sits in a shell variable is still judged", () => {
  assert.equal(cua.judgeCuaShell(`A='{"pid":1,"keys":["cmd","shift","d"]}'; cua-driver call hotkey "$A"`, () => "com.apple.mail", () => []).length, 1);
  blocked("bash", [`A='{"pid": 1, "path": ["Message", "Send"]}'; cua-driver call invoke_menu "$A"`]);
  allowed("bash", [`A='{"pid": 1, "window_id": 1}'; cua-driver call get_window_state "$A"`]);
});
