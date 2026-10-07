import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BoardStore } from "../src/chat-board-store.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { LocalFileError, readLocalText, textKind } from "../src/chat-render.ts";
import { readWikiPage } from "../src/chat-wiki.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBoard } from "../src/shared/types.ts";

test("POST api/threads/:id/board: owner todo and scratch ops apply, a tapped choice steers 'chose', the board is broadcast, the chat gets a [board] steer; non-chats 404, plan ops 403", async () => {
  const boards = new BoardStore(await mkdtemp(join(tmpdir(), "board-route-")));
  await boards.apply("chat1", [{ op: "plan_add", text: "Goal" }, { op: "todo_add", text: "Approve the Email picks" },
    { op: "todo_add", text: "Deploy now?", choices: ["Yes", "Wait for QA"] }], "agent");
  const prompts: { id: string; message: string; mode: string }[] = [];
  const broadcast: { id: string; rev: number }[] = [];
  const backend = {
    chats: { ids: async () => new Set(["chat1"]) },
    boards,
    threads: {
      setBoard(id: string, board: ChatBoard) { broadcast.push({ id, rev: board.rev }); },
      async prompt(id: string, input: { message: string; mode: string }) { prompts.push({ id, message: input.message, mode: input.mode }); },
    },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = async (id: string, body: unknown) => {
    const res = await fetch(server.url + `api/threads/${id}/board`, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Chat-Token": "token", Origin: origin } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  try {
    const checked = await post("chat1", { ops: [{ op: "todo_update", id: "t1", done: true, reply: "Use Resend" }] });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.sent, true);
    assert.equal((checked.body.board as ChatBoard).rev, 4);
    assert.deepEqual(prompts, [{ id: "chat1", message: '[board] Owner checked "Approve the Email picks" and answered: Use Resend', mode: "steer" }]);
    assert.deepEqual(broadcast, [{ id: "chat1", rev: 4 }]);
    const added = await post("chat1", { ops: [{ op: "todo_add", text: "Call me at 5" }, { op: "todo_remove", id: "t1" }] });
    assert.equal(prompts[1]!.message, '[board] Owner added a todo "Call me at 5"; Owner removed the todo "Approve the Email picks"');
    assert.deepEqual((added.body.board as ChatBoard).todos.map(todo => [todo.id, todo.from]), [["t2", "agent"], ["t3", "owner"]]);
    await post("chat1", { ops: [{ op: "todo_update", id: "t2", reply: "Wait for QA", done: true }] });
    assert.equal(prompts[2]!.message, '[board] Owner chose "Wait for QA" for "Deploy now?"');
    const noted = await post("chat1", { ops: [{ op: "scratch_add", text: "Read this first", links: [{ label: "report", target: "/Users/me/w8-report.md" }] }] });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.equal(prompts[3]!.message, '[board] Owner added a note: "Read this first" with links [report](file:/Users/me/w8-report.md)');
    assert.equal((await post("plain", { ops: [{ op: "todo_add", text: "x" }] })).status, 404);
    assert.equal((await post("chat1", { ops: [{ op: "plan_update", id: "p1", status: "done" }] })).status, 403);
    assert.equal((await post("chat1", { ops: [{ op: "todo_update", id: "t9", done: true }] })).status, 409);
    assert.equal((await post("chat1", { ops: [] })).status, 400);
    assert.equal((await post("chat1", { ops: [{ op: "todo_add" }] })).status, 400);
    assert.equal((await post("chat1", { ops: [{ op: "scratch_add", text: "x", links: [{ target: "ftp://x" }] }] })).status, 400);
    assert.equal(prompts.length, 4, "refused ops send nothing");
    assert.equal((await boards.read("chat1"))?.rev, 8);
  } finally { await server.close(); }
});

test("readLocalText: any UTF-8 text file under a root, with its kind; no hidden parts, no service secrets, symlinks resolved, size, NUL and UTF-8 checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-text-"));
  const root = join(dir, "root");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "report.md"), "# Report\n");
  await writeFile(join(root, "readme.diff"), "--- a\n+++ b\n");
  await writeFile(join(root, "main.py"), "print(1)\n");
  await writeFile(join(root, "Makefile"), "all:\n");
  await writeFile(join(root, ".git", "config.txt"), "x");
  await writeFile(join(root, "configuration.json"), "{}");
  await writeFile(join(root, "bin.txt"), Buffer.from([0xff, 0xfe, 0x00]));
  await writeFile(join(root, "big.log"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await writeFile(join(root, "image.png"), Buffer.concat([Buffer.from("\x89PNG\r\n"), Buffer.alloc(16, 0)]));
  await writeFile(join(dir, "outside.md"), "secret");
  await symlink(join(dir, "outside.md"), join(root, "link.md"));
  const read = (path: string) => readLocalText(path, [root]);
  const status = (path: string) => read(path).then(() => 200, (error: unknown) => error instanceof LocalFileError ? error.status : 500);
  const report = await read(join(root, "report.md"));
  assert.deepEqual({ text: report.text, kind: report.kind }, { text: "# Report\n", kind: "markdown" });
  assert.equal((await read(join(root, "readme.diff"))).kind, "diff");
  const script = await read(join(root, "main.py"));
  assert.deepEqual({ text: script.text, kind: script.kind, language: script.kind === "code" ? script.language : null }, { text: "print(1)\n", kind: "code", language: "py" });
  assert.deepEqual(textKind(join(root, "Makefile")), { kind: "code", language: "" });
  assert.equal(await status(join(root, ".git", "config.txt")), 403);
  assert.equal(await status(join(root, "configuration.json")), 403);
  assert.equal(await status(join(root, "link.md")), 403, "a symlink out of the root is refused");
  assert.equal(await status(join(root, "bin.txt")), 415, "a NUL byte marks a binary file");
  assert.equal(await status(join(root, "big.log")), 413);
  assert.equal(await status(join(root, "image.png")), 415);
  assert.equal(await status(join(root, "missing.md")), 404);
  assert.equal(await status("report.md"), 400);
  assert.deepEqual(textKind("/x/notes.patch"), { kind: "diff" });
  assert.deepEqual(textKind("/x/README.MD"), { kind: "markdown" });
  assert.deepEqual(textKind("/x/app.svelte"), { kind: "code", language: "svelte" });
});

test("readWikiPage: the page text through the dev server API; the wiki's refusal and silence become reader errors", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("missing")) return new Response(JSON.stringify({ error: "Page not found" }), { status: 404 });
    if (url.includes("slow")) await new Promise(resolve => setTimeout(resolve, 50));
    if (url.includes("down")) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ path: "sessions/a/report.html", title: "Chats build", headings: ["Chats", "Proof"], render: "text", content: "Chats\n\nA chat is\nProof\n" }), { status: 200 });
  }) as typeof fetch;
  const page = await readWikiPage("/sessions/a/report.html", fetchImpl, "http://wiki.test");
  assert.deepEqual(page, { path: "sessions/a/report.html", title: "Chats build", url: "http://wiki.test/page/sessions/a/report.html", text: "Chats\n\nA chat is\nProof\n", headings: ["Chats", "Proof"] });
  assert.equal(calls[0], "http://wiki.test/api/agent/page?path=sessions%2Fa%2Freport.html&render=text");
  const status = (path: string) => readWikiPage(path, fetchImpl, "http://wiki.test").then(() => 200, (error: unknown) => error instanceof LocalFileError ? error.status : 500);
  assert.equal(await status("sessions/missing.html"), 404);
  assert.equal(await status("down/page.html"), 502);
  assert.equal(await status("../etc/passwd"), 400);
  assert.equal(await status(""), 400);
});

test("GET api/local-file serves an allowed text file as {path, text}; POST unarchive restores a chat", async () => {
  const calls: string[] = [];
  const backend = {
    chats: { ids: async () => new Set<string>(), restore: async (id: string) => { calls.push(`restore ${id}`); return id === "chat1"; } },
    threads: { unarchive: async (id: string) => { calls.push(`unarchive ${id}`); } },
    catalog: { notify: async () => { calls.push("notify"); } },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const get = async (path: string) => {
    const res = await fetch(server.url + "api/local-file?path=" + encodeURIComponent(path));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  try {
    const readme = fileURLToPath(new URL("../README.md", import.meta.url));
    if (readme.startsWith(join(homedir(), "Documents", "Github") + "/")) {
      const served = await get(readme);
      assert.equal(served.status, 200, JSON.stringify(served.body));
      assert.match(String(served.body.text), /^# /);
    }
    assert.equal((await get("/etc/hosts.txt")).status, 404);
    assert.notEqual((await get(join(homedir(), ".prime", "agent", "browser-chat", "configuration.json"))).status, 200, "the service tokens never leave");
    for (const id of ["chat1", "plain"]) {
      const res = await fetch(server.url + `api/threads/${id}/unarchive`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-Chat-Token": "token", Origin: origin } });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(calls, ["unarchive chat1", "restore chat1", "notify", "unarchive plain", "restore plain"]);
  } finally { await server.close(); }
});
