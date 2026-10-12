import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The send guard (owner correction c37) on shell send kinds. These tests only feed strings to the handler; nothing here runs them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-shell-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../components/global-rules/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text, ctx = { cwd: root }) => guard.onToolCall(event(toolName, text), ctx);

function blocked(toolName, texts) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /send guard/, `${toolName}: ${text}`);
  }
}

function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

test("mail CLIs block a send and allow reading, listing, saving and help", () => {
  blocked("bash", [
    "mail -s 'Invoice' bob@example.com < body.txt",
    "mailx -s hi bob@example.com",
    "mail bob@example.com",
    "sendmail -t < msg.eml",
    "/usr/sbin/sendmail bob@example.com < msg.eml",
    "msmtp -a work bob@example.com < msg.eml",
    "swaks --to bob@example.com --server smtp.example.com",
    "mutt -s 'hello' bob@example.com < body.txt",
    "neomutt -s hi -a file.pdf -- bob@example.com",
    "himalaya send < msg.eml",
    "himalaya message reply 42",
    "himalaya message forward 42",
    "himalaya message write",
    "himalaya -a work message reply 42 --all",
  ]);
  allowed("bash", [
    "mail",
    "mail -f ~/mbox",
    "mailx -H -f ~/mbox",
    "mutt -f ~/Mail/inbox",
    "himalaya list",
    "himalaya envelope list --page 2",
    "himalaya message read 42 --folder Sent",
    "himalaya message save < m.eml",
    "sendmail --version",
    "msmtp --version",
    "swaks --help",
    "mutt -v",
    "himalaya --version",
  ]);
});

test("Mail.app AppleScript and Gmail or ticket CLIs block a send verb and allow other verbs", () => {
  blocked("bash", [
    `osascript -e 'tell application "Mail" to send (make new outgoing message with properties {subject:"hi"})'`,
    'osascript -e "tell application \\"Mail\\" to send theMessage"',
    "gmail send --to bob@example.com --body hi",
    "gog gmail send --to bob@example.com",
    "gam user me sendemail to bob@example.com subject hi",
    "zendesk ticket reply 123 --body hi",
  ]);
  allowed("bash", [
    `osascript -e 'tell application "Mail" to get subject of messages of inbox'`,
    "gmail list --unread",
    "gog gmail search 'from:vendor'",
    "zendesk tickets list",
    "freshdesk ticket show 12",
  ]);
});

test("wrappers, nested shells, substitutions, pipes and chains still reach the mail CLI", () => {
  blocked("bash", [
    "env X=1 sudo msmtp bob@example.com < msg.eml",
    "env -i PATH=/usr/bin msmtp a@b.c < m.eml",
    "sudo -u sieun sendmail -t < m.eml",
    "nohup sendmail -t < m.eml &",
    "bash -lc 'msmtp bob@example.com < m.eml'",
    'zsh -c "mail -s hi bob@example.com < b"',
    "sh -c 'cd x; sendmail -t < m'",
    "echo $(sendmail -t < m.eml)",
    "echo `msmtp a@b.c`",
    "(sendmail -t < m.eml)",
    "cat msg.eml | msmtp -t",
    "printf 'hi' | /usr/bin/mail -s subj a@b.c",
    "cd /tmp && swaks --to a@b.c",
    "true && himalaya message reply 7 || echo failed",
    "bash -lc 'curl -X POST https://api.resend.com/emails -d @e.json'",
  ]);
});

test("curl, wget, httpie and xh writes to mail send APIs are blocked", () => {
  blocked("bash", [
    "curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send -H 'Authorization: Bearer x' -d @msg.json",
    `curl -s https://gmail.googleapis.com/gmail/v1/users/me/drafts/send --json '{"id":"r1"}'`,
    "curl -XPOST https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media -T msg.eml",
    "curl -X POST https://graph.microsoft.com/v1.0/me/sendMail -d @mail.json",
    "curl --request POST https://graph.microsoft.com/v1.0/me/messages/AAA/reply -d '{}'",
    "curl https://api.sendgrid.com/v3/mail/send -H 'Authorization: Bearer k' -d @payload.json",
    "curl -sd @m.json https://api.sendgrid.com/v3/mail/send",
    "TOKEN=x curl -d @m.json https://api.sendgrid.com/v3/mail/send",
    "cat m.json | curl -d @- https://api.sendgrid.com/v3/mail/send",
    "curl -s --user 'api:key' https://api.mailgun.net/v3/mg.example.com/messages -F from=a@b.c -F to=d@e.f -F text=hi",
    "curl https://api.eu.mailgun.net/v3/x/messages -F to=a@b.c",
    "curl -X POST https://api.postmarkapp.com/email -d '{}'",
    "curl -X POST https://api.resend.com/emails --data '{}'",
    "curl -X POST https://email.us-east-1.amazonaws.com/v2/email/outbound-emails -d @m.json",
    `wget --post-data='{"id":1}' https://gmail.googleapis.com/gmail/v1/users/me/drafts/send`,
    "wget --method=POST --body-file=m.json https://api.sendgrid.com/v3/mail/send",
    "http POST https://api.resend.com/emails to=a@b.c subject=hi",
    "http https://api.resend.com/emails to=a@b.c",
    "xh post https://api.postmarkapp.com/email To=a@b.c",
  ]);
});

test("HTTP writes to ticket APIs and curl SMTP uploads are blocked", () => {
  blocked("bash", [
    `curl -X PUT https://acme.zendesk.com/api/v2/tickets/123.json -d '{"ticket":{"comment":{"body":"hi"}}}'`,
    `curl -u me:key -X POST https://acme.freshdesk.com/api/v2/tickets/12/reply -d '{"body":"hi"}'`,
    "curl -X POST https://api.intercom.io/conversations/123/reply -d '{}'",
    "xh https://api.intercom.io/conversations/1/reply body=hi",
    "curl -X POST https://api.helpscout.net/v2/conversations/1/reply -d '{}'",
    "curl -X POST https://api2.frontapp.com/conversations/cnv_1/messages -d '{}'",
    `curl -X POST https://acme.atlassian.net/rest/servicedeskapi/request/SD-1/comment -d '{"body":"hi"}'`,
    "curl https://billing.vendor.com/includes/api.php -d action=AddTicketReply -d ticketid=5 -d message=hi",
    "curl --url smtps://smtp.gmail.com:465 --mail-from me@x.com --mail-rcpt vendor@y.com --upload-file m.eml",
    "curl smtp://mail.example.com --mail-rcpt a@b.c -T m.eml",
  ]);
});

test("HTTP reads, Gmail draft creates, localhost and unrelated hosts are allowed next to a blocked send", () => {
  blocked("bash", ["curl -X POST https://api.sendgrid.com/v3/mail/send -d @m.json"]);
  allowed("bash", [
    "curl https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:vendor",
    "curl -X GET https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    "curl https://api.sendgrid.com/v3/mail/send",
    "curl -I https://api.postmarkapp.com/email",
    "curl -s https://acme.zendesk.com/api/v2/tickets/123.json",
    "curl -s -H 'Authorization: Bearer x' https://acme.zendesk.com/api/v2/tickets/123/comments.json",
    "wget -qO- https://acme.freshdesk.com/api/v2/tickets",
    "wget https://api.mailgun.net/v3/x/events",
    "http GET https://api.intercom.io/conversations/1",
    "http https://api.intercom.io/conversations/1 Authorization:'Bearer x'",
    "xh https://api.helpscout.net/v2/conversations page==2",
    "curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts -d @draft.json",
    "curl -X POST https://graph.microsoft.com/v1.0/me/messages/A/createReply",
    "curl -X POST https://billing.vendor.com/includes/api.php -d action=GetTickets",
    "curl -X POST http://localhost:5173/api/send -d '{}'",
    "curl -X POST http://127.0.0.1:8788/tickets -d '{}'",
    `curl -X POST https://api.github.com/repos/o/r/issues -d '{"title":"x"}'`,
    "curl -X POST https://hooks.slack.com/services/T/B/x -d '{}'",
    "curl -X POST https://api.stripe.com/v1/charges -d amount=1",
    "curl --version",
    "wget --help",
  ]);
});

test("aside exec prompts and aside repl code that send are blocked, and read-only prompts are allowed", () => {
  blocked("bash", [
    'aside exec "Open the Zendesk ticket from Acme and reply to the vendor ticket email saying we accept the quote."',
    'aside exec "Reply to the latest email from support@vendor.com."',
    'aside exec "Send the drafted email in Gmail."',
    'aside exec "답장 메일 보내줘"',
    "bash -lc 'aside exec \"reply to the support ticket\"'",
    `aside repl "await page.click('div[aria-label=\\"Send\\"]')"`,
    `aside repl "await page.getByRole('button', { name: 'Send' }).click()"`,
    `aside repl "await page.keyboard.press('Meta+Enter')"`,
    `aside repl "await page.locator('.T-I.aoO').click()"`,
  ]);
  allowed("bash", [
    'aside exec "read the ticket thread, do not send anything"',
    'aside exec "Summarize my inbox. Do not reply to any email."',
    'aside exec "Open github.com and list my PRs"',
    `aside repl "console.log(await page.title())"`,
    `aside repl "await page.click('text=Sent')"`,
    "aside --help",
  ]);
});

test("ipython bash calls, subprocess argv lists, bang lines and %%bash cells get the same send checks", () => {
  blocked("ipython", [
    'h = bash("msmtp vendor@acme.com < reply.eml")',
    'r = await bash("curl -X POST https://api.sendgrid.com/v3/mail/send -d @m.json")',
    'subprocess.run("curl smtps://smtp.gmail.com --mail-rcpt v@acme.com -T m.eml", shell=True)',
    'subprocess.run(["sendmail", "-t"], input=msg, text=True)',
    'subprocess.run(["bash", "-lc", "msmtp a@b.c < m.eml"])',
    'subprocess.run(["himalaya", "message", "reply", "42"])',
    'subprocess.run(["curl", "-X", "POST", "https://api.intercom.io/conversations/1/reply", "-d", "{}"])',
    'subprocess.run(["http", "POST", "https://api.resend.com/emails", "to=a@b.c"])',
    'subprocess.run(["aside", "exec", "Reply to the vendor ticket email and say yes."])',
    `os.system("osascript -e 'tell application \\"Mail\\" to send m'")`,
    '!mail -s "Re: quote" vendor@acme.com < body.txt',
    '!aside exec "send the email to the vendor"',
    "h = bash('aside exec \"reply to the vendor ticket email with the attached quote\"')",
    `h = bash("aside repl \\"await page.click('div[aria-label=Send]')\\"")`,
    "%%bash\ncd drafts\nswaks --to vendor@acme.com --body reply.txt",
    "%%bash\nif [ -f m.eml ]; then\n  sendmail -t < m.eml\nfi",
  ]);
  allowed("ipython", [
    'h = bash("himalaya envelope list")',
    'subprocess.run(["mail", "-f", "inbox"])',
    'subprocess.run(["sendmail", "--version"])',
    'h = bash("curl -s https://acme.zendesk.com/api/v2/tickets/123.json")',
    'subprocess.run(["curl", "-X", "POST", "https://api.github.com/repos/o/r/issues", "-d", "{}"])',
    'h = bash("curl -X POST http://localhost:3000/api/email/send -d @m.json")',
    "h = bash('aside exec \"read the ticket thread, do not send anything\"')",
    '# bash("sendmail -t < m.eml")\nprint("ok")',
    'note = "msmtp vendor@acme.com < reply.eml"\nprint(note)',
  ]);
});

test("read-only commands that only name mail tools or send URLs are allowed in bash and ipython", () => {
  blocked("bash", ["msmtp vendor@acme.com < reply.eml"]);
  const reads = [
    "rg -n sendmail",
    "rg -n 'mail -s' docs/",
    "grep -n swaks README.md",
    "man msmtp",
    "which himalaya",
    "command -v sendmail",
    "type msmtp",
    "cat ~/.msmtprc",
    "brew install himalaya msmtp",
    "pnpm add @sendgrid/mail resend",
    "git commit -m 'reply to the vendor mail'",
    "echo 'curl -X POST https://api.sendgrid.com/v3/mail/send' > notes.md",
  ];
  allowed("bash", reads);
  allowed("ipython", [
    ...reads.map((cmd) => `!${cmd}`),
    `%%bash\n${reads.join("\n")}`,
    `h = bash("echo 'curl -X POST https://api.sendgrid.com/v3/mail/send' > notes.md")`,
  ]);
});

test("review findings: wrappers, keywords, scheme-less httpie and osascript argv block; drafting prompts, curl -G and non-desk hosts pass", () => {
  blocked("bash", [
    "if true; then sendmail -t < m; fi",
    "for r in a b; do msmtp $r < m; done",
    "timeout 30 sendmail -t < m.eml",
    "xargs -n1 msmtp < rcpts.txt",
    "ssh mailhost 'sendmail -t < m.eml'",
    "http POST acme.zendesk.com/api/v2/tickets.json ticket:=@t.json",
    "http -f POST api.mailgun.net/v3/x/messages to=a@b.c",
  ]);
  blocked("ipython", [`subprocess.run(["osascript", "-e", 'tell application "Mail" to send theMessage'])`]);
  allowed("bash", [
    'aside exec "Draft a reply to the vendor ticket and leave it unsent."',
    'aside exec "Write a draft reply to the vendor email. Save it as a draft."',
    "curl -G https://acme.zendesk.com/api/v2/search.json -d query=type:ticket",
    "curl --get -d q=x https://api.intercom.io/conversations/search",
    "curl -X POST https://staging.virev.ai/api/tickets -d '{}'",
    "curl -X POST https://help.example.org/api/search -d q=x",
    "ssh build-box 'docker ps'",
    "timeout 30 curl -sS https://api.sendgrid.com/v3/stats",
  ]);
});
