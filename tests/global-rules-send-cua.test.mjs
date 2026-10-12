import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

// The cua-driver send guard (owner correction c37): desktop clicks and key presses that send mail or a message need the owner's approved todo.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-send-cua-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const data = join(root, "chat");
mkdirSync(join(data, "boards"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = data;
const cua = await import("../components/global-rules/cua-guard.ts");
const guard = await import("../components/global-rules/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const CHAT = "01a00000-0000-7000-8000-0000000000c4";
const at = "2026-10-10T00:00:00.000Z";
writeFileSync(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], scratch: [], updatedAt: at, todos: [
  { id: "t1", text: "Send this reply?", choices: ["Send it", "Not yet"], from: "agent", at, done: true, reply: "Send it", answeredBy: "owner" },
  { id: "t2", text: "Send this reply?", choices: ["Send it", "Not yet"], from: "agent", at, done: true, reply: "Not yet", answeredBy: "owner" },
] }));

const MAIL = { bundle: "com.apple.mail", titles: ["New Message"] };
const MESSAGES = { bundle: "com.apple.MobileSMS", titles: ["Messages"] };
const FINDER = { bundle: "com.apple.finder", titles: ["Downloads"] };
const BROWSER_TICKET = { bundle: "net.imput.helium", titles: ["[Ticket ID: iWF-1] - Client Area - Helium"] };
const el = (label, frame = { x: 10, y: 10, w: 40, h: 20 }) => ({ label, role: "AXButton", frame });
const decide = (tool, args, ctx) => cua.decide(tool, args, ctx, (token) => (token === `${CHAT}/t1` ? null : "not a go"));

test("Mail.app Send by element, by menu and by Cmd+Shift+D or Cmd+Return is refused", () => {
  for (const [tool, args, ctx] of [
    ["click", { pid: 1, element_token: "s:0" }, { ...MAIL, element: el("Send") }],
    ["double_click", { pid: 1, element_token: "s:0" }, { ...MAIL, element: el("Send") }],
    ["invoke_menu", { pid: 1, path: ["Message", "Send"] }, MAIL],
    ["hotkey", { pid: 1, keys: ["cmd", "shift", "d"] }, MAIL],
    ["hotkey", { pid: 1, keys: ["cmd", "return"] }, MAIL],
    ["press_key", { pid: 1, key: "return", modifiers: ["cmd"] }, MAIL],
  ]) {
    const why = decide(tool, args, ctx);
    assert.match(why ?? "", /cua-driver send guard: refused/, `${tool} ${JSON.stringify(args)}`);
    assert.match(why, /For you todo/);
  }
});

test("a coordinate click that lands on Send in a mail window is refused, and one with no snapshot asks for a snapshot first", () => {
  assert.match(decide("click", { pid: 1, x: 30, y: 20 }, { ...MAIL, snapshot: [el("Archive", { x: 100, y: 10, w: 40, h: 20 }), el("Send")] }), /lands on "Send"/);
  assert.match(decide("click", { pid: 1, x: 60, y: 40 }, { ...MAIL, snapshot: [el("Send")] }), /lands on "Send"/);
  assert.match(decide("click", { pid: 1, x: 30, y: 20 }, MAIL), /no snapshot/);
  assert.match(decide("click", { pid: 1, element_token: "unknown:9" }, MAIL), /has not seen/);
});

test("Return in a chat app and Submit on a ticket page in a desktop browser are refused", () => {
  assert.match(decide("press_key", { pid: 2, key: "return" }, MESSAGES), /Return sends/);
  assert.match(decide("click", { pid: 3, element_token: "s:1" }, { ...BROWSER_TICKET, element: el("Submit") }), /presses "Submit"/);
  assert.match(decide("click", { pid: 3, element_token: "s:1" }, { bundle: "net.imput.helium", titles: ["anything"], element: el("Send") }), /presses "Send"/);
});

test("an approved owner_ok lets a send through, and a held one keeps the block with the reason", () => {
  const args = { pid: 1, element_token: "s:0" };
  assert.equal(decide("click", { ...args, owner_ok: `${CHAT}/t1` }, { ...MAIL, element: el("Send") }), null);
  assert.match(decide("click", { ...args, owner_ok: `${CHAT}/t2` }, { ...MAIL, element: el("Send") }), /does not count: not a go/);
  assert.equal(cua.decide("hotkey", { pid: 1, keys: ["cmd", "shift", "d"], owner_ok: `${CHAT}/t1` }, MAIL), null);
  assert.match(cua.decide("hotkey", { pid: 1, keys: ["cmd", "shift", "d"], owner_ok: `${CHAT}/t2` }, MAIL), /not a go/);
});

test("reads, typing into a draft and non-send clicks pass", () => {
  for (const [tool, args, ctx] of [
    ["type_text", { pid: 1, text: "Hi Thomas," }, MAIL],
    ["click", { pid: 1, element_token: "s:1" }, { ...MAIL, element: el("Archive") }],
    ["click", { pid: 1, element_token: "s:2" }, { ...MAIL, element: el("Send to Back") }],
    ["click", { pid: 1, x: 120, y: 20 }, { ...MAIL, snapshot: [el("Archive", { x: 100, y: 10, w: 40, h: 20 }), el("Send")] }],
    ["hotkey", { pid: 1, keys: ["cmd", "n"] }, MAIL],
    ["hotkey", { pid: 1, keys: ["shift", "return"] }, MESSAGES],
    ["press_key", { pid: 4, key: "return" }, FINDER],
    ["click", { pid: 4, element_token: "s:3" }, { ...FINDER, element: el("Submit") }],
    ["hotkey", { pid: 4, keys: ["cmd", "return"] }, FINDER],
    ["get_window_state", { pid: 1, window_id: 7 }, MAIL],
    ["invoke_menu", { pid: 1, path: ["Message", "Reply"] }, MAIL],
  ]) {
    assert.equal(decide(tool, args, ctx), null, `${tool} ${JSON.stringify(args)}`);
  }
});

test("a replayed trajectory with a Send turn is refused", () => {
  const dir = join(root, "trajectory");
  mkdirSync(join(dir, "turn-00001"), { recursive: true });
  writeFileSync(join(dir, "turn-00001", "action.json"), JSON.stringify({ tool: "hotkey", arguments: { pid: 1, keys: ["cmd", "shift", "d"] } }));
  const seen = new cua.Seen();
  assert.match(cua.decideCall(seen, "replay_trajectory", { dir }, () => "com.apple.mail", () => "not a go") ?? "", /replayed turn/);
  assert.equal(cua.decideCall(seen, "replay_trajectory", { dir }, () => "com.apple.finder", () => "not a go"), null);
});

test("`cua-driver call` in bash is refused unless OWNER_OK names an approved todo", () => {
  const send = `cua-driver call hotkey '{"pid": 4242, "keys": ["cmd", "shift", "d"]}'`;
  assert.equal(cua.judgeCuaShell(send, () => "com.apple.mail", () => []).length, 1);
  assert.equal(cua.judgeCuaShell(`cua-driver call type_text '{"pid": 4242, "text": "hi"}'`, () => "com.apple.mail", () => []).length, 0);
  assert.equal(cua.judgeCuaShell(`cua-driver call get_window_state '{"pid": 4242, "window_id": 1}'`, () => "com.apple.mail", () => []).length, 0);
  const viaGuard = guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "bash", input: { command: `cua-driver call invoke_menu '{"pid": 1, "path": ["Message", "Send"]}'` } }, { cwd: root });
  assert.equal(viaGuard?.block, true);
});

test("a click that names its window only through a nested target is judged against that window", () => {
  const seen = new cua.Seen();
  seen.record("get_window_state", { pid: 4242, window_id: 7 }, { structuredContent: { pid: 4242, window_id: 7, window_title: "New Message", elements: [el("Send")] } });
  const bundle = (pid) => (pid === 4242 ? "com.apple.mail" : undefined);
  const target = { kind: "window", pid: 4242, window_id: 7 };
  assert.match(cua.decideCall(seen, "click", { target, x: 30, y: 20 }, bundle, () => "not a go") ?? "", /lands on "Send"/);
  assert.match(cua.decideCall(seen, "hotkey", { target, keys: ["cmd", "shift", "d"] }, bundle, () => "not a go") ?? "", /Cmd\+Shift\+D/);
  assert.equal(cua.decideCall(seen, "click", { target, x: 120, y: 20 }, bundle, () => "not a go"), null);
  assert.equal(cua.judgeCuaShell(`cua-driver call click '${JSON.stringify({ target, x: 30, y: 20 })}'`, bundle, () => ["New Message"]).length, 1);
});

test("a click aimed at the desktop is judged against the window under its point, and a Send under an unknown window is refused", () => {
  const seen = new cua.Seen();
  const frame = (x, y, w, h) => ({ x, y, w, h });
  seen.record("get_window_state", { pid: 4242, window_id: 7 }, { structuredContent: { pid: 4242, window_id: 7, window_title: "New Message", elements: [
    { label: "", role: "AXWindow", frame: frame(200, 100, 400, 300) },
    { label: "Send", role: "AXButton", frame: frame(210, 110, 40, 20) },
  ] } });
  const bundle = (pid) => (pid === 4242 ? "com.apple.mail" : undefined);
  const mail = { pid: 4242, window_id: 7, title: "New Message", app_name: "Mail", bounds: { x: 200, y: 100, width: 400, height: 300 }, z_index: 1 };
  const overlay = { pid: 9, window_id: 1, title: "", app_name: "Cua Driver", bounds: { x: 0, y: 0, width: 1800, height: 1169 }, z_index: 3 };
  const desktop = () => ({ scale: 2, windows: [overlay, mail] });
  const no = () => "not a go";
  for (const aim of [{ scope: "desktop" }, { target: { kind: "desktop", display_id: "primary" } }]) {
    assert.match(cua.decideCall(seen, "click", { ...aim, x: 460, y: 240 }, bundle, no, desktop) ?? "", /lands on "Send" in com\.apple\.mail/);
    assert.equal(cua.decideCall(seen, "click", { ...aim, x: 900, y: 240 }, bundle, no, desktop), null);
    assert.match(cua.decideCall(seen, "hotkey", { ...aim, keys: ["cmd", "shift", "d"] }, bundle, no, desktop) ?? "", /Cmd\+Shift\+D/);
  }
  assert.match(cua.decideCall(seen, "click", { pid: 4242, window_id: 7, x: 20, y: 20 }, bundle, no, desktop) ?? "", /lands on "Send"/);
  assert.match(cua.decideCall(seen, "click", { scope: "desktop", x: 460, y: 240 }, bundle, no, () => undefined) ?? "", /lands on "Send" in a window the guard could not identify/);
  assert.equal(cua.decideCall(seen, "click", { scope: "desktop", x: 900, y: 240 }, bundle, no, () => undefined), null);
  assert.match(cua.decideCall(seen, "hotkey", { scope: "desktop", keys: ["cmd", "return"] }, bundle, no, () => undefined) ?? "", /sends in a window the guard could not identify/);
  assert.equal(cua.judgeCuaShell(`cua-driver call click '${JSON.stringify({ scope: "desktop", x: 460, y: 240 })}'`, bundle, () => [], desktop).length, 1);
});

const DISCORD = { bundle: "com.hnc.Discord", titles: ["#general - Discord"] };
const TELEGRAM = { bundle: "ru.keepcoder.Telegram", titles: ["Telegram"] };
const WHATSAPP = { bundle: "net.whatsapp.WhatsApp", titles: ["WhatsApp"] };
const SLACK = { bundle: "com.tinyspeck.slackmacgap", titles: ["Slack"] };
const CHROME = (title) => ({ bundle: "com.google.Chrome", titles: [title] });

test("cua-7: type_text that ends in a newline in a chat app, Slack desktop included, sends and is refused; a multi-line mail draft passes", () => {
  for (const ctx of [MESSAGES, DISCORD, TELEGRAM, WHATSAPP, SLACK]) {
    assert.match(decide("type_text", { pid: 4, text: "hi\n" }, ctx) ?? "", /cua-driver send guard: refused/, ctx.bundle);
    assert.match(decide("type_text", { pid: 4, text: "line one\rline two" }, ctx) ?? "", /cua-driver send guard: refused/, ctx.bundle);
    assert.equal(decide("type_text", { pid: 4, text: "hi" }, ctx), null, ctx.bundle);
  }
  assert.equal(decide("type_text", { pid: 1, text: "Hi Thomas,\n\nThanks for the fix.\n" }, MAIL), null);
  assert.equal(decide("type_text", { pid: 4, text: "hi\n", owner_ok: `${CHAT}/t1` }, DISCORD), null);
});

test("cua-9: Submit or Send in a browser window titled like a contact or support form is refused", () => {
  for (const title of ["Contact us - Vendor", "Contact Support | Acme - Google Chrome", "Submit a request – Acme Help Center"]) {
    assert.match(decide("click", { pid: 2, element_token: "s:3" }, { ...CHROME(title), element: el("Submit") }) ?? "", /cua-driver send guard: refused/, title);
  }
  assert.equal(decide("click", { pid: 2, element_token: "s:3" }, { ...CHROME("Search results - Google Search"), element: el("Submit") }), null);
  assert.equal(decide("click", { pid: 2, element_token: "s:3", owner_ok: `${CHAT}/t1` }, { ...CHROME("Contact us - Vendor"), element: el("Submit") }), null);
});

test("cua-13: Post or Tweet in a browser window on X / Twitter or LinkedIn is refused", () => {
  for (const [title, label] of [["Home / X", "Post"], ["(3) Home / X - Google Chrome", "Post"], ["Home / Twitter", "Tweet"], ["Feed | LinkedIn", "Post"], ["Messaging | LinkedIn", "Send"]]) {
    assert.match(decide("click", { pid: 2, element_token: "s:4" }, { ...CHROME(title), element: el(label) }) ?? "", /cua-driver send guard: refused/, `${title} ${label}`);
  }
  assert.equal(decide("click", { pid: 2, element_token: "s:4" }, { ...CHROME("Home / X"), element: el("Bookmarks") }), null);
  assert.equal(decide("click", { pid: 2, element_token: "s:4" }, { ...CHROME("Blog post draft - Notion"), element: el("Post") }), null);
});

// The MCP proxy in front of a fake cua-driver: refused calls never reach the driver; allowed calls reach it without owner_ok.
async function proxy() {
  const log = join(root, `fake-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const child = spawn(process.execPath, ["components/global-rules/cua-guard.ts", process.execPath, "tests/fixtures-fake-cua.mjs"], {
    cwd: join(import.meta.dirname, ".."), env: { ...process.env, FAKE_CUA_LOG: log }, stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const tool = (name, args) => call("tools/call", { name, arguments: args });
  const received = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { call, tool, received, close: () => child.kill() };
}

test("the MCP proxy refuses a Send click before it reaches cua-driver and lets an approved one through without owner_ok", async () => {
  const p = await proxy();
  try {
    const list = await p.call("tools/list", {});
    assert.ok(list.result.tools.find((t) => t.name === "click").inputSchema.properties.owner_ok);
    await p.tool("get_window_state", { pid: 4242, window_id: 7 });
    const refused = await p.tool("click", { pid: 4242, window_id: 7, element_token: "s1:0" });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /presses "Send"/);
    assert.equal(p.received().filter((m) => m.params?.name === "click").length, 0);
    const archive = await p.tool("click", { pid: 4242, window_id: 7, element_token: "s1:1" });
    assert.equal(archive.result.content[0].text, "done click");
    const approved = await p.tool("click", { pid: 4242, window_id: 7, element_token: "s1:0", owner_ok: `${CHAT}/t1` });
    assert.equal(approved.result.content[0].text, "done click");
    const clicks = p.received().filter((m) => m.params?.name === "click");
    assert.equal(clicks.length, 2);
    assert.equal("owner_ok" in clicks[1].params.arguments, false);
  } finally {
    p.close();
  }
});
