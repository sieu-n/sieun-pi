// Owner, 10-22 about 06:45Z: frontend bro's Prompt dialog on the chat host read "rebuilt" though frontend bro runs on the Mac, whose user-history
// extension had captured its payload 2 minutes before. The chat host reads another box's files only through that box's relay, whose roots held
// sessions, session-artifacts and logs but not browser-chat/prompts, so the capture was never read there.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Host } from "../src/hosts.ts";
import { readHostCapture } from "../src/prompt-host-capture.ts";

const SESSION = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const SUBAGENT = "01a1626a-0000-7000-8000-000000000001";

test("the chat host reads a Mac session's captured payload through the Mac relay's default roots", async t => {
  const home = await mkdtemp(join(tmpdir(), "relay-capture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".prime", "agent");
  const capture = (id: string) => ({ capturedAt: "2026-10-22T06:51:02.000Z", sessionId: id, sessionFile: null, provider: "anthropic", model: "claude-opus-5-5",
    payload: { system: [{ type: "text", text: "You are Prime." }], tools: [], messages: [{ role: "user", content: "hi" }] } });
  await mkdir(join(agentDir, "browser-chat", "prompts"), { recursive: true });
  for (const id of [SESSION, SUBAGENT]) await writeFile(join(agentDir, "browser-chat", "prompts", `${id}.json`), JSON.stringify(capture(id)));
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  const token = "t".repeat(40);
  await writeFile(join(home, "token"), token);
  // relay.json as install.mjs writes it on a box that never listed roots, so the relay's own default roots apply.
  await writeFile(join(home, "relay.json"), JSON.stringify({ listen: "127.0.0.1", port: 0, daemonSocket: "/tmp/none.sock", tokenFile: join(home, "token") }));
  const relayModule = "../../../../components/prime-relay/relay.mjs";
  const { createRelay, loadConfig } = await import(relayModule) as { createRelay: (config: object) => Server; loadConfig: (file: string) => object };
  const previous = process.env.HOME;
  process.env.HOME = home;
  let config: object;
  try { config = loadConfig(join(home, "relay.json")); } finally { process.env.HOME = previous; }
  const relay = createRelay(config);
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (relay.address() as AddressInfo).port, token: `file:${join(home, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };

  const read = await readHostCapture(host, join(agentDir, "sessions", `${SESSION}.jsonl`), SESSION);
  assert.equal(read?.capturedAt, "2026-10-22T06:51:02.000Z");
  assert.deepEqual(read?.payload, capture(SESSION).payload);
  const subagentFile = join(agentDir, "session-artifacts", SESSION, "sub-0000aaaa", `${SUBAGENT}.jsonl`);
  assert.equal((await readHostCapture(host, subagentFile, SUBAGENT))?.sessionId, SUBAGENT);
  assert.equal(await readHostCapture(host, "/elsewhere/file.jsonl", SESSION), null);
});

test("install.mjs adds the prompt captures to the relay roots of a box that already has a relay.json", async () => {
  const install = await readFile(fileURLToPath(new URL("../../../../components/prime-relay/install.mjs", import.meta.url)), "utf8");
  const roots = /const ROOTS = (\[[^\]]*\]);/.exec(install)?.[1];
  assert.ok(roots && (JSON.parse(roots) as string[]).includes("~/.prime/agent/browser-chat/prompts"), "install.mjs ROOTS lists ~/.prime/agent/browser-chat/prompts");
});

test("a Mac capture is read once while its size and time hold, without its image data, and again once it changes", async t => {
  const home = await mkdtemp(join(tmpdir(), "relay-capture-kept-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".prime", "agent");
  const file = join(agentDir, "browser-chat", "prompts", `${SESSION}.json`);
  const data = "iVBORw0KGgo".repeat(10_000);
  const capture = (text: string) => ({ capturedAt: "2026-10-22T06:51:02.000Z", sessionId: SESSION, sessionFile: null, provider: "anthropic", model: "m",
    payload: { system: "s", messages: [{ role: "user", content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(capture("first")));
  await writeFile(join(home, "token"), "t".repeat(40));
  const relayModule = "../../../../components/prime-relay/relay.mjs";
  const { createRelay } = await import(relayModule) as { createRelay: (config: object) => Server };
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: "/tmp/none.sock", tokenFile: join(home, "token"), token: "t".repeat(40), roots: [agentDir] });
  const methods: string[] = [];
  relay.on("request", (request: { method?: string }) => methods.push(request.method ?? ""));
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const host: Host = { name: "mac-kept", hostname: "mac", address: "127.0.0.1", relayPort: (relay.address() as AddressInfo).port, token: `file:${join(home, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  const sessionFile = join(agentDir, "sessions", `${SESSION}.jsonl`);

  const first = await readHostCapture(host, sessionFile, SESSION);
  assert.ok(!JSON.stringify(first).includes(data), "the image data is left out");
  assert.equal(await readHostCapture(host, sessionFile, SESSION), first);
  assert.deepEqual(methods, ["HEAD", "GET", "HEAD"]);
  await writeFile(file, JSON.stringify(capture("second, longer")));
  const next = await readHostCapture(host, sessionFile, SESSION);
  assert.equal((next?.payload as { messages: { content: { text?: string }[] }[] }).messages[0]!.content[0]!.text, "second, longer");
  assert.deepEqual(methods.slice(3), ["HEAD", "GET"]);
});
