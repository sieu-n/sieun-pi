// Guards the owner's 10-28 ask for Slack-like message search on the :5182 chat (wiki sessions/2026/10/28/0410-slack-layer-design): typing in the
// sidebar box offers "Search messages for", the panel groups hits by thread with three per thread, and a hit opens its thread at that message,
// a subagent's hit in the subagent's own thread. It drives a real serve with its own --port and --data-dir, a fake daemon and a fake pi-history
// socket behind api/search, never the live chat.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import { chrome, devtools } from "./devtools-pipe.ts";
import type { Hit, SearchResult } from "../src/client/search.ts";

const cli = fileURLToPath(new URL("../src/chat-service-cli.mjs", import.meta.url));
const CAPABILITIES = ["abort_and_send_queued", "acp_mcp_servers", "agent_roster", "authoritative_child_roster", "client_owned_sessions", "delete_rlm_subagent",
  "heartbeat_catalog", "heartbeat_management", "model_catalog", "owned_prompt_cancellation", "owned_session_recovery_context", "prompt_admission_cancellation",
  "queue_message_mutation", "rlm_quiescence_barrier", "session_input_admission", "session_input_pause"];
const freePort = () => new Promise<number>(resolve => {
  const server = createHttpServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

const THREAD = "01a1face-0000-7000-8000-00000000000a", SUB = "01a1face-0000-7000-8000-00000000000b", MAC = "01a1face-0000-7000-8000-00000000000c";
const START = Date.UTC(2026, 9, 23, 4, 0, 0);
/** Thread lines one minute apart; the hits name lines 12, 20, 24 and 27, so the opened one sits well above the thread's bottom. */
const at = (line: number) => START + line * 60_000;
const SUB_AT = START + 90 * 60_000;
/** The Mac's one hit is the newest, so when the Mac answers late its thread lands above the rows already shown. */
const MAC_AT = START + 120 * 60_000;
/** How long the fake Mac takes to answer, and so the merged answer that waits for it. */
const MAC_MS = 2000;

/** A saved session file: the header, then a user and an assistant message per pair of lines, each with its own timestamp. */
function sessionFile(path: string, id: string, cwd: string, lines: { at: number; text: string }[]): void {
  const entries = [{ type: "session", version: 3, id, timestamp: new Date(START - 60_000).toISOString(), cwd }];
  let parentId: string | null = null;
  lines.forEach((line, index) => {
    const entryId = id.slice(-4) + String(index).padStart(4, "0");
    const role = index % 2 === 0 ? "user" : "assistant";
    const message = role === "user" ? { role, content: [{ type: "text", text: line.text }], timestamp: line.at }
      : { role, content: [{ type: "text", text: line.text }], api: "anthropic-messages", provider: "anthropic", model: "claude-test", stopReason: "stop", timestamp: line.at,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    entries.push({ type: "message", id: entryId, parentId, timestamp: new Date(line.at).toISOString(), message } as never);
    parentId = entryId;
  });
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

const hit = (session: string, line: number, kind: Hit["kind"], snippet: string, extra: Partial<Hit> = {}): Hit => ({
  ref: `us-metal02:${session}@${at(line)}#${line}`, box: "us-metal02", source: "prime", session, root: session, depth: 0, thread: "hosts relay timeout job",
  kind, author: kind === "user" ? "owner" : "hosts relay timeout job", at: at(line), snippet, ...extra });
const FIXTURE: SearchResult = {
  hits: [
    hit(THREAD, 27, "assistant", "the Mac copy was stale, so the read <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> time"),
    hit(THREAD, 24, "tool_result", "relay mac (100.66.173.18:7790) <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> 15000 ms &lt;tag&gt;", { tool: "ipython", isError: true }),
    hit(SUB, 0, "user", "probe: why the relay <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> 15 s", { ref: `us-metal02:${SUB}@${SUB_AT}#90`, at: SUB_AT,
      root: THREAD, parent: THREAD, depth: 1, thread: "relay probe", rootName: "hosts relay timeout job", author: "parent", kind: "agent_message" }),
    hit(THREAD, 20, "user", "why <mark>did</mark> the relay <mark>not</mark> <mark>answer</mark> <mark>in</mark> time?"),
    hit(THREAD, 12, "assistant", "first sign: the relay <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> 15000 ms"),
    hit(MAC, 3, "assistant", "on the Mac the daemon list <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> 3 s", { ref: `mac:${MAC}@${MAC_AT}#3`, at: MAC_AT, box: "mac", thread: "slack green guy" }),
  ],
  total: 49, tookMs: 14, scope: "all",
  boxes: { "us-metal02": { ok: true, tookMs: 9, backfillPct: 61, bytesTotal: 14e9 }, mac: { ok: false, error: "relay mac did not answer in 3000 ms", tookMs: 3000, backfillPct: 0 } },
};
/** Older hits in threads of their own, so the list scrolls and can hold a chosen row in place while rows land above it. */
const FILLER: Hit[] = Array.from({ length: 16 }, (_, index) => hit(`01a1face-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`, -10 - index, "assistant",
  `older run ${index}: the relay <mark>did</mark> <mark>not</mark> <mark>answer</mark> <mark>in</mark> time`, { thread: `older job ${index}` }));
/** Each box's own answer to `box=<name>`: us-metal02 counts 40 hits and the Mac 9, the 49 of the merged answer. */
const BOX_ANSWERS: Record<string, SearchResult> = {
  "us-metal02": { hits: [...FIXTURE.hits.filter(one => one.box === "us-metal02"), ...FILLER], total: 40, tookMs: 9, scope: "all", boxes: { "us-metal02": { ok: true, tookMs: 9, backfillPct: 100 } } },
  mac: { hits: FIXTURE.hits.filter(one => one.box === "mac"), total: 9, tookMs: 30, scope: "all", boxes: { mac: { ok: true, tookMs: 30, backfillPct: 100 } } },
};

test("sidebar typing offers message search, the panel groups hits by thread, and Enter opens the thread at that message", { skip: chrome ? false : "no Chrome on this host", timeout: 120_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "search-panel-"));
  let browser: ReturnType<typeof devtools> | undefined;
  t.after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
  const home = join(dir, "home"), data = join(dir, "data"), socketPath = join(dir, "daemon.sock");
  const sessions = join(home, ".prime/agent/sessions"), artifacts = join(home, ".prime/agent/session-artifacts", THREAD, "sub-probe");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const files: Record<string, string> = { [THREAD]: join(sessions, `${THREAD}.jsonl`), [SUB]: join(artifacts, `${SUB}.jsonl`) };
  sessionFile(files[THREAD]!, THREAD, dir, Array.from({ length: 40 }, (_, line) => ({ at: at(line), text: `thread line ${line}` })));
  sessionFile(files[SUB]!, SUB, dir, [{ at: SUB_AT, text: "probe line 0" }, { at: SUB_AT + 60_000, text: "probe line 1" }]);
  const row = (id: string, name: string, parent?: string) => ({ sessionId: id, activeSessionId: `${id.slice(-4)}active`, cwd: dir, sessionFile: files[id], messageCount: 2,
    name, modified: new Date(START + 3_600_000).toISOString(), ...(parent ? { parentSessionId: parent } : {}) });
  const rows = [row(THREAD, "hosts relay timeout job"), row(SUB, "relay probe", THREAD)];

  const sockets = new Set<Socket>();
  const daemon = createNetServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30,
      serverCapabilities: CAPABILITIES, appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let wire: Record<string, unknown>;
        try { wire = JSON.parse(line); } catch { continue; }
        const command = (wire.type === "command" ? wire.command : wire) as Record<string, unknown>;
        const type = String(command.type);
        if (type === "ack_result") continue;
        const data = type === "list" ? { sessions: rows } : type === "cron_list" ? { jobs: [] } : type === "get_messages" ? { messages: [] } : {};
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); daemon.close(); });

  // A fake pi-history on its own socket: the serve's api/search reaches it through PI_HISTORY_SOCKET, and it records each query it got.
  const historySocket = join(dir, "history.sock");
  const searches: Record<string, string>[] = [];
  // Without box= it answers once the Mac does, as pi-history merges; with box=us-metal02 at once and with box=mac after MAC_MS.
  let macAnswered = false;
  const history = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://pi-history");
    if (url.pathname !== "/v1/search") { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" })); return; }
    searches.push(Object.fromEntries(url.searchParams));
    const box = url.searchParams.get("box");
    const answer = box ? BOX_ANSWERS[box]! : FIXTURE;
    const reply = () => { if (box === "mac") macAnswered = true; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)); };
    if (box === "us-metal02") reply(); else setTimeout(reply, MAC_MS);
  });
  await new Promise<void>(resolve => history.listen(historySocket, resolve));
  t.after(() => { history.closeAllConnections(); history.close(); });

  const port = await freePort();
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const pool = join(dir, "pi-pool");
  writeFileSync(pool, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_POOL_BIN: pool, SIEUN_PI_CHAT_START_DAEMON: "0", SIEUN_PI_CHAT_OPEN_AT_LOGIN: "0", SIEUN_PI_SLACK: "0", PI_HISTORY_SOCKET: historySocket };
  for (const name of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"]) delete env[name];
  const child = spawn(process.execPath, [cli, "serve", "--data-dir", data, "--port", String(port), "--socket", socketPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  t.after(() => { child.kill("SIGKILL"); });
  const urlPattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/[^\\s]*`);
  for (let waited = 0; !urlPattern.test(log); waited += 200) {
    assert.ok(waited < 60_000 && child.exitCode === null, `the serve did not start:\n${log}`);
    await delay(200);
  }
  const base = urlPattern.exec(log)![0];

  browser = devtools(chrome!, join(dir, "profile"), "about:blank");
  const { targetInfos } = await browser.send("Target.getTargets");
  const page = targetInfos.find((target: { type: string }) => target.type === "page");
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const send = (method: string, params: object = {}) => browser!.send(method, params, sessionId);
  await send("Page.enable");
  const loaded = new Promise<void>(resolve => browser!.onEvent("Page.loadEventFired", sessionId, resolve));
  await send("Page.navigate", { url: base });
  await loaded;
  const evaluate = async (expression: string) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  const until = async (condition: string, what: string) => {
    const met = await evaluate(`new Promise(resolve => { const end = Date.now() + 20000; const look = () => (${condition}) ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(look, 25); look(); })`);
    assert.ok(met, `${what}\n${await evaluate("document.body.innerText.slice(0, 3000)")}\n${log.slice(-2000)}`);
  };
  const key = (key: string, code: string, keyCode: number, modifiers = 0, text?: string) => (async () => {
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
  })();

  await until(`document.querySelector('a[data-row="${THREAD}"]')`, "the sidebar lists the thread");
  await evaluate(`document.querySelector('input[aria-label="Search threads"]').focus()`);
  await send("Input.insertText", { text: "did not answer in" });
  await until(`document.querySelector("[data-search-messages]")`, "typing in the sidebar box adds the Search messages row");
  assert.equal(await evaluate(`document.querySelector("[data-search-messages]").innerText.replace(/\\s+/g, " ").trim()`), "Search messages for “did not answer in” ↵");
  await key("Enter", "Enter", 13, 0, "\r");

  // A page whose rows name no box asks once for the merged answer, and keeps the box names it names for the next search.
  await until(`document.querySelectorAll(".hit").length === 5`, "the panel shows the Mac's hit, the subagent's and three of the thread");
  assert.deepEqual(searches, [{ q: "did not answer in", sort: "newest" }]);
  const groups = await evaluate(`[...document.querySelectorAll("#search-results .thread")].map(head => head.innerText.replace(/\\s+/g, " ").trim())`);
  assert.equal(groups.length, 3, groups.join("\n"));
  assert.match(groups[0], /^slack green guy mac Oct 23, /);
  assert.match(groups[1], /^hosts relay timeout job relay probe us-metal02 /);
  assert.match(groups[2], /^hosts relay timeout job us-metal02 /);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".more")].map(more => more.innerText.trim())`), ["1 more in this thread"]);
  assert.equal(await evaluate(`[...document.querySelectorAll(".hit .kind")].map(kind => kind.innerText).join(" | ")`),
    "assistant | agent message from parent | assistant | tool error (ipython) | you");
  const errorHit = `.hit[data-at="${at(24)}"]`;
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(errorHit)}).querySelector(".snippet").innerText`), "relay mac (100.66.173.18:7790) did not answer in 15000 ms <tag>");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(errorHit)}).querySelectorAll("mark").length`), 4);
  assert.match(await evaluate(`document.querySelector(".count").innerText`), /^49 results in 14 ms$/);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".notice")].map(notice => notice.innerText)`),
    ["The Mac is offline, so its messages are not in these results.", "Still reading older history: 61% of 14.0 GB. Newer messages are searched already."]);

  // The rows run Mac, subagent, then the thread's lines 27, 24 and 20 with line 12 folded into "1 more"; Down four times lands on line 20,
  // and Enter opens the thread there.
  for (let step = 0; step < 4; step += 1) await key("ArrowDown", "ArrowDown", 40);
  assert.equal(await evaluate(`document.querySelector(".hit.active").dataset.at`), String(at(20)));
  await key("Enter", "Enter", 13, 0, "\r");
  await until(`!document.querySelector("dialog[aria-label='Search messages']")`, "Enter closes the panel");
  assert.equal(await evaluate(`location.search + location.hash`), `?t=${THREAD}#${THREAD}@${at(20)}`);
  await until(`document.querySelector('[data-at="${at(20)}"].linked')`, "the thread flashes the hit's message");
  // The message stays in view after the turns above it take their real height (permalink.ts settle).
  await delay(500);
  const place = await evaluate(`(() => { const message = document.querySelector('[data-at="${at(20)}"]').getBoundingClientRect(); const view = document.querySelector(".scroller").getBoundingClientRect();
    return { top: message.top - view.top, bottom: view.bottom - message.bottom }; })()`);
  assert.ok(place.top >= 0 && place.bottom >= 0, `the message sits outside the scroller: ${JSON.stringify(place)}`);

  // Cmd+Shift+F (Ctrl+Shift+F here) opens the panel on the same results; the subagent's hit opens the subagent as its own thread.
  await key("F", "KeyF", 70, 2 | 8);
  await until(`document.querySelectorAll(".hit").length === 5`, "the shortcut opens the panel on the last results");
  assert.equal(await evaluate(`document.querySelector("[data-search-query]") === document.activeElement`), true);
  await evaluate(`document.querySelector('.hit[data-session="${SUB}"]').click()`);
  assert.equal(await evaluate(`location.search + location.hash`), `?t=${SUB}#${SUB}@${SUB_AT}`);
  await until(`document.querySelector('[data-at="${SUB_AT}"].linked')`, "the subagent's thread flashes the hit's message");

  // "1 more in this thread" asks again with the thread as the Chat filter, now once per box the first answer named: us-metal02's hits show while
  // the Mac still answers, and the Mac's newer thread lands above them without moving the chosen row.
  await key("F", "KeyF", 70, 2 | 8);
  await until(`document.querySelector(".more")`, "the panel shows the more line");
  await evaluate(`document.querySelector(".more").click()`);
  await until(`document.querySelectorAll(".hit").length === 4 + ${FILLER.length} && !document.querySelector('.hit[data-session="${MAC}"]')`, "us-metal02's hits show before the Mac answers");
  assert.equal(macAnswered, false, "the local hits waited for the Mac");
  assert.deepEqual((searches as Record<string, string>[]).slice(1).sort((a, b) => String(a.box).localeCompare(String(b.box))), [
    { q: "did not answer in", sort: "newest", chat: THREAD, box: "mac" }, { q: "did not answer in", sort: "newest", chat: THREAD, box: "us-metal02" }]);
  assert.match(await evaluate(`document.querySelector(".count").innerText`), /^40 results in 9 ms$/);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".notice")].map(notice => notice.innerText)`), ["Searching the Mac…"]);
  await key("ArrowDown", "ArrowDown", 40);
  const chosen = `.hit[data-at="${at(27)}"]`;
  assert.equal(await evaluate(`document.querySelector(".hit.active") === document.querySelector(${JSON.stringify(chosen)})`), true);
  const topBefore = await evaluate(`document.querySelector(${JSON.stringify(chosen)}).getBoundingClientRect().top`);
  await until(`document.querySelector('.hit[data-session="${MAC}"]')`, "the Mac's hit merges in once it answers");
  await delay(100);
  assert.match(await evaluate(`document.querySelector(".count").innerText`), /^49 results in 30 ms$/);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".notice")].map(notice => notice.innerText)`), []);
  assert.match(await evaluate(`document.querySelector("#search-results .thread").innerText.replace(/\\s+/g, " ")`), /^slack green guy mac /);
  assert.equal(await evaluate(`document.querySelector(".hit.active") === document.querySelector(${JSON.stringify(chosen)})`), true, "the chosen row stays chosen");
  const topAfter = await evaluate(`document.querySelector(${JSON.stringify(chosen)}).getBoundingClientRect().top`);
  assert.ok(Math.abs(topAfter - topBefore) < 2, `the chosen row moved from ${topBefore} to ${topAfter} px`);
  await key("Escape", "Escape", 27);
  await until(`!document.querySelector("dialog[aria-label='Search messages']")`, "Esc closes the panel");
});
