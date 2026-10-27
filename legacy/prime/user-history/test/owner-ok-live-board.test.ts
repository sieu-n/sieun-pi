// Guards slack green guy's t26 of 10-18: the owner answered "Go: fix the links" at 08:44Z on the board on us-metal02, but the send guard on the
// Mac read the Mac's copy of the board, which had stopped at 08:01Z when the chat moved, and refused OWNER_OK with "Chat ... has no todo t26".
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { remoteChatService } from "../src/chat-host.ts";
import { ownerOk } from "../src/owner-ok.ts";

const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const at = "2026-10-18T08:44:40.140Z";
const t26 = { id: "t26", text: "Can I fix the links in our four trial emails?", choices: ["Go: fix the links", "Not yet"], from: "agent", at, done: true, reply: "Go: fix the links", answeredBy: "owner" };

async function setup(live: boolean) {
  const root = await mkdtemp(join(tmpdir(), "owner-ok-live-"));
  const data = join(root, "browser-chat");
  await mkdir(join(data, "boards"), { recursive: true });
  await writeFile(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1328, plan: [], todos: [] }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/cap/api/agent/board" && url.searchParams.get("chat") === CHAT) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ v: 2, rev: 1400, plan: [], todos: [t26] })); return; }
    res.writeHead(404); res.end("{\"error\":\"No board for this chat.\"}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  if (!live) server.close();
  const hosts = join(root, "hosts.json");
  await writeFile(hosts, JSON.stringify({ version: 1, hosts: [
    { name: "chat-box", hostname: "chat-box-not-this-one", address: "127.0.0.1", relayPort: 7790, token: "file:relay-tokens/chat-box", daemonSocket: "/tmp/chat-box.sock", roles: { chat: { port, url: `http://127.0.0.1:${port}` } } },
  ] }));
  const access = join(root, "chat-access.json");
  await writeFile(access, JSON.stringify({ capability: "cap", csrfToken: "token" }));
  return { data, server, remote: () => remoteChatService(hosts, access) };
}

test("a box whose local board is stale gets t26 approved from the chat host's live board", async () => {
  const { data, server, remote } = await setup(true);
  try {
    const result = await ownerOk(`${CHAT}/t26`, "", data, remote);
    assert.equal(result.ok, true);
    assert.match(result.source ?? "", /chat host http:\/\/127\.0\.0\.1:/);
    const missing = await ownerOk(`01a00000-0000-7000-8000-000000000000/t1`, "", data, remote);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.reason, /no board on the chat host/);
  } finally { server.close(); }
});

test("when the chat host cannot be reached the local file answers and the reason says so", async () => {
  const { data, remote } = await setup(false);
  const result = await ownerOk(`${CHAT}/t26`, "", data, remote);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /no todo t26.*local file .*could not be reached/);
});
