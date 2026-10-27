import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Send guard (correction c37) for ipython cells. These strings are only fed to the handler, never run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-python-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const call = (code) => guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "ipython", input: { code } }, { cwd: root });

function assertBlocked(codes) {
  for (const code of codes) {
    const result = call(code);
    assert.equal(result?.block, true, code);
    assert.match(result.reason, /send guard/, code);
  }
}

function assertAllowed(codes) {
  for (const code of codes) assert.equal(call(code), undefined, code);
}

test("HTTP writes from the kernel to mail APIs are blocked", () => {
  assertBlocked([
    'import requests\nrequests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", json={"raw": raw}, headers=h)',
    'import httpx\nr = httpx.post("https://graph.microsoft.com/v1.0/me/sendMail", json=msg)',
    'async with httpx.AsyncClient() as c:\n    await c.put("https://api.sendgrid.com/v3/mail/send", json=payload)',
    'async with aiohttp.ClientSession() as s:\n    await s.post("https://api.mailgun.net/v3/mg.example.com/messages", data=form)',
    'requests.request(method="POST", url="https://api.postmarkapp.com/email", json=body)',
    'httpx.request(method="POST", url="https://api.resend.com/emails", json=body)',
    's = requests.Session()\ns.post("https://api.resend.com/emails", json=body)',
    'URL = "https://api.sendgrid.com/v3/mail/send"\nrequests.post(URL, json=payload)',
    'urllib.request.urlopen(urllib.request.Request("https://api.sendgrid.com/v3/mail/send", data=b, method="POST"))',
  ]);
});

test("HTTP writes from the kernel to ticket APIs are blocked", () => {
  assertBlocked([
    'import urllib.request\nreq = urllib.request.Request("https://acme.zendesk.com/api/v2/tickets/42.json", data=b, method="PUT")\nurllib.request.urlopen(req)',
    'requests.put(f"https://{sub}.zendesk.com/api/v2/tickets/{tid}.json", json=upd)',
    'urllib.request.urlopen("https://acme.freshdesk.com/api/v2/tickets/7/reply", data=payload)',
    'requests.post("https://api.intercom.io/conversations/123/reply", json={"message_type": "comment"})',
    'requests.post("https://billing.example.net/includes/api.php", data={"action": "AddTicketReply", "ticketid": 5, "message": m})',
  ]);
});

test("GETs to mail and ticket hosts and posts to local or unrelated hosts are allowed", () => {
  assertAllowed([
    'requests.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", headers=h)',
    'httpx.get("https://acme.zendesk.com/api/v2/tickets/42.json", auth=a)',
    'requests.post("http://localhost:5180/api/agent/sessions", json={"title": "support tickets"})',
    'requests.post("http://127.0.0.1:8788/v1/send", json=b)',
    'httpx.post("https://api.github.com/repos/sieu-n/r/issues", json=issue)',
  ]);
  assertBlocked(['httpx.post("https://acme.zendesk.com/api/v2/tickets/42.json", auth=a)']);
});

test("SMTP sends from the kernel are blocked", () => {
  assertBlocked([
    'import smtplib\nwith smtplib.SMTP("smtp.gmail.com", 587) as s:\n    s.starttls(); s.login(u, p)\n    s.sendmail(frm, [to], msg.as_string())',
    'from smtplib import SMTP_SSL\nserver = SMTP_SSL("smtp.example.com", 465)\nserver.send_message(msg)',
    'import smtplib\ns = smtplib.SMTP_SSL(host, 465)\ns.login(u, p)\ns.send_message(msg)\ns.quit()',
    'import yagmail\nyag = yagmail.SMTP("me@gmail.com")\nyag.send(to="vendor@example.com", subject="Re: ticket", contents=body)',
  ]);
});

test("importing smtplib and writing an EmailMessage draft to a file are allowed", () => {
  const draft = 'from email.message import EmailMessage\nmsg = EmailMessage()\nmsg["To"] = "vendor@example.com"\nmsg["Subject"] = "Re: ticket"\nmsg.set_content(body)\n';
  assertAllowed([
    "import smtplib\nprint(smtplib.SMTP_PORT)",
    `${draft}open("draft.eml", "wb").write(bytes(msg))`,
    `import smtplib\n${draft}Path("draft.eml").write_bytes(bytes(msg))`,
  ]);
  assertBlocked([`import smtplib\n${draft}smtplib.SMTP("smtp.example.com").send_message(msg)`]);
});

test("the Gmail API client's messages send and drafts send are blocked while drafts create and list are allowed", () => {
  assertBlocked([
    'service.users().messages().send(userId="me", body={"raw": raw}).execute()',
    'service.users().drafts().send(userId="me", body={"id": draft_id}).execute()',
    'resp = (\n    service.users()\n    .messages()\n    .send(userId="me", body=b)\n    .execute()\n)',
  ]);
  assertAllowed([
    'service.users().drafts().create(userId="me", body={"message": {"raw": raw}}).execute()',
    'service.users().messages().list(userId="me", q="from:vendor").execute()',
  ]);
});

test("MCP mail and ticket send tools are blocked", () => {
  assertBlocked([
    'await mcp.call_tool("gmail", "send_email", {"to": "vendor@example.com", "body": "hi"})',
    'await mcp.call_tool("gmail", "send_email", arguments={"to": "x@y.com"})',
    'await mcp.call_tool(\n    "gmail",\n    "send_email",\n    {"to": "vendor@example.com", "body": "hi"},\n)',
    'await mcp.call_tool("gmail", "send_email", {\n  "to": "vendor@example.com",\n  "body": "Hi (see below)",\n})',
    'await mcp.call_tool("zendesk", "create_comment", {"ticket_id": 42, "body": "Thanks"})',
    'res = await mcp.call_tool("intercom", "reply_to_conversation", {"id": "1", "body": "ok"})',
    'r = mcp.call_tool("outlook", "reply_message", {"id": "1"})',
  ]);
});

test("MCP mail reads and drafts and non-mail comment tools are allowed", () => {
  assertAllowed([
    'await mcp.call_tool("gmail", "search_threads", {"query": "from:acme"})',
    'await mcp.call_tool("gmail", "list_drafts", {})',
    'await mcp.call_tool("gmail", "create_draft", {"to": "v@x.com", "body": "hi"})',
    'await mcp.call_tool("linear", "create_comment", {"issueId": "ENG-1", "body": "done"})',
    'await mcp.call_tool("notion", "create_comment", {"page": "x", "text": "y"})',
  ]);
  assertBlocked(['await mcp.call_tool("gmail", "send_email", {"query": "from:acme"})']);
});

test("raw Aside MCP calls that press Send or ask the agent to reply are blocked unless the prompt says not to send", () => {
  assertBlocked([
    "await mcp.call_tool(\"aside\", \"repl\", {\"code\": \"await page.getByRole('button', { name: 'Send' }).click()\"})",
    'await mcp.call_tool("aside", "exec", {"prompt": "Open Gmail and reply to the vendor ticket email from Acme with the draft below."})',
    'await mcp.call_tool("aside", "exec", {"prompt": "Gmail에서 벤더 메일에 답장 보내줘"})',
  ]);
  assertAllowed([
    'await mcp.call_tool("aside", "repl", {"code": "return document.title"})',
    'await mcp.call_tool("aside", "exec", {"prompt": "Draft an answer to the vendor email in Gmail but do not send it."})',
    'await mcp.call_tool("aside", "exec", {"prompt": "Open the vendor email in Gmail and write a draft, never send it."})',
  ]);
});

test("text that only mentions a send and agent_message or aside_browser calls are allowed", () => {
  assertAllowed([
    'report = \'I did not run requests.post("https://api.sendgrid.com/v3/mail/send") because c37 needs the owner ok.\'',
    '# requests.post("https://api.sendgrid.com/v3/mail/send", json=payload)\nprint("draft only")',
    'print("yagmail can send mail; we only draft")',
    '# service.users().messages().send(userId="me", body=b).execute()',
    'await agent_message.send(report, receiver_role="parent")',
    'await agent_message.send("Drafted the Zendesk reply; requests.post to https://acme.zendesk.com/api/v2/tickets/42.json is waiting on the owner.", receiver_role="parent")',
    'await aside_browser.run("Open Gmail and send the reply to the vendor ticket")',
    'await aside_browser.run("""await page.click(\'[aria-label="Send"]\')""")',
  ]);
  assertBlocked(['requests.post("https://api.sendgrid.com/v3/mail/send", json=payload)']);
});

test("review findings: positional POST, aiosmtplib, backslash chains, keyword MCP args and a bare url name block; body URLs and queue.put pass", () => {
  assertBlocked([
    'requests.request("POST", "https://api.postmarkapp.com/email", json=body)',
    'import aiosmtplib\nawait aiosmtplib.send(msg, hostname="smtp.example.com")',
    'svc.users() \\\n   .messages() \\\n   .send(userId="me", body=b).execute()',
    'await mcp.call_tool(server="gmail", tool="send_email", arguments={"to": "x"})',
    'url = "https://api.sendgrid.com/v3/mail/send"\nrequests.post(url, json=p)',
  ]);
  assertAllowed([
    'r = requests.get("https://acme.zendesk.com/api/v2/tickets.json")\nq.put(r.json())',
    'requests.post("http://localhost:5180/api/notes", json={"note": "vendor said see https://acme.zendesk.com/hc/requests/42"})',
    'httpx.post("https://api.github.com/repos/sieu-n/r/issues", json={"body": "Ref https://acme.freshdesk.com/a/tickets/9"})',
    'await mcp.call_tool("aside", "exec", {"prompt": "Open Gmail and draft a reply to the vendor ticket email. Do not send it."})',
  ]);
});
