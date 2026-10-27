// Guards the round trip a new thread on another box spent between its create's answer and its first prompt: about 190 ms to the Mac on 10-20.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transform } from "node:stream";

const MODULE = "../../../../components/prime-relay/first-prompt.mjs";
const { firstPromptTunnel, FIRST_PROMPT_FIELD } = await import(MODULE) as {
  firstPromptTunnel: (log?: (line: string) => void) => { outbound: Transform; inbound: Transform }; FIRST_PROMPT_FIELD: string };

const lines = (stream: Transform) => {
  const got: Record<string, unknown>[] = [];
  let rest = "";
  stream.on("data", (chunk: Buffer) => { rest += chunk.toString("utf8"); for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) { got.push(JSON.parse(rest.slice(0, end))); rest = rest.slice(end + 1); } });
  return got;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const envelope = (id: string, command: Record<string, unknown>) => ({ type: "command", id, protocol: { name: "prime-agent.daemon", version: 7 }, clientId: "daemon-client:box", command });

test("the relay sends a create's first prompt the moment the create answers, and holds the answer until the prompt's", async () => {
  const { outbound, inbound } = firstPromptTunnel();
  const toDaemon = lines(outbound), toClient = lines(inbound);
  outbound.write(JSON.stringify(envelope("daemon_1", { type: "create", lifecycle: "resident", config: { cwd: "/Users/x" },
    [FIRST_PROMPT_FIELD]: { message: "hi", source: "interactive", streamingBehavior: "followUp", queueIfBusy: true, ownerTurn: true } })) + "\n");
  await tick();
  assert.deepEqual(toDaemon.map(line => (line.command as Record<string, unknown>).type), ["create"]);
  assert.equal(FIRST_PROMPT_FIELD in (toDaemon[0]!.command as object), false, "the daemon gets the create it always got");
  inbound.write('{"type":"session_event","activeSessionId":"other","event":{"type":"message_update"}}\n');
  inbound.write(JSON.stringify({ id: "daemon_1", type: "response", command: "create", success: true, data: { activeSessionId: "a1", sessionId: "s1" } }) + "\n");
  await tick();
  assert.deepEqual(toClient.map(line => line.type), ["session_event"], "the create's answer waits for the prompt's");
  assert.deepEqual(toDaemon[1], envelope("relay_first_daemon_1", { id: "relay_first_daemon_1", type: "prompt", activeSessionId: "a1", message: "hi", source: "interactive",
    streamingBehavior: "followUp", queueIfBusy: true, ownerTurn: "s1" }));
  inbound.write(JSON.stringify({ id: "relay_first_daemon_1", type: "response", command: "prompt", success: true }) + "\n");
  await tick();
  assert.deepEqual(toDaemon[2], envelope("relay_first_daemon_1_ack", { id: "relay_first_daemon_1_ack", type: "ack_result", commandId: "relay_first_daemon_1" }));
  assert.deepEqual(toClient[1], { id: "daemon_1", type: "response", command: "create", success: true, data: { activeSessionId: "a1", sessionId: "s1" }, [FIRST_PROMPT_FIELD]: { success: true } });
  assert.equal(toClient.length, 2, "the prompt's own answer stays in the relay");
});

test("a refused prompt comes back on the create's answer, and a failed create passes as it came with no prompt", async () => {
  const { outbound, inbound } = firstPromptTunnel();
  const toDaemon = lines(outbound), toClient = lines(inbound);
  for (const id of ["c1", "c2"]) outbound.write(JSON.stringify({ id, type: "create", config: { cwd: "/x" }, [FIRST_PROMPT_FIELD]: { message: "hi" } }) + "\n");
  inbound.write(JSON.stringify({ id: "c1", type: "response", command: "create", success: false, error: "no cwd" }) + "\n");
  inbound.write(JSON.stringify({ id: "c2", type: "response", command: "create", success: true, data: { activeSessionId: "a2", sessionId: "s2" } }) + "\n");
  await tick();
  assert.deepEqual(toDaemon[2], { id: "relay_first_c2", type: "prompt", activeSessionId: "a2", message: "hi" }, "a bare command gets a bare prompt and no ack");
  inbound.write(JSON.stringify({ id: "relay_first_c2", type: "response", command: "prompt", success: false, error: "busy" }) + "\n");
  await tick();
  assert.deepEqual(toClient, [{ id: "c1", type: "response", command: "create", success: false, error: "no cwd" },
    { id: "c2", type: "response", command: "create", success: true, data: { activeSessionId: "a2", sessionId: "s2" }, [FIRST_PROMPT_FIELD]: { success: false, error: "busy" } }]);
  assert.equal(toDaemon.length, 3);
});

test("lines with no first prompt pass byte for byte, split across chunks", async () => {
  const { outbound, inbound } = firstPromptTunnel();
  const out: Buffer[] = [], back: Buffer[] = [];
  outbound.on("data", (chunk: Buffer) => out.push(chunk));
  inbound.on("data", (chunk: Buffer) => back.push(chunk));
  const command = '{"id":"x","type":"create","config":{"cwd":"/x"}}\n{"id":"y","type":"prompt","message":"relayFirstPrompt"}\n';
  outbound.write(command.slice(0, 20)); outbound.write(command.slice(20));
  inbound.write('{"id":"x","type":"response","command":"create","success":true,"data":{}}\n');
  await tick();
  assert.equal(Buffer.concat(out).toString("utf8"), command);
  assert.equal(Buffer.concat(back).toString("utf8"), '{"id":"x","type":"response","command":"create","success":true,"data":{}}\n');
});
