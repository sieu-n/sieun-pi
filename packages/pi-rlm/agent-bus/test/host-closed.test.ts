import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { HostClient } from "../../../pi-host/src/client.ts";
import { PiHost } from "../../../pi-host/src/host.ts";
import { listen } from "../../../pi-host/src/server.ts";
import { kernelHandler } from "../../../pi-family/kernel-bridge.ts";
import * as registry from "../../../pi-family/registry.ts";
import { repliedSinceTask } from "../src/state.ts";
import { landed, until } from "./rig.ts";

/** A closed child inside pi-host: the host keeps a dormant row for it, and a send from its parent or from a client reopens it. */

const HERE = dirname(fileURLToPath(import.meta.url));
let root: string;
let host: PiHost;
let server: Server;
let client: HostClient;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-bus-host-child-"));
  for (const dir of ["agent", "sessions", "ws"]) mkdirSync(join(root, dir), { recursive: true });
  host = new PiHost({
    agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"),
    extensions: [join(HERE, "..", "index.ts"), join(HERE, "fixtures", "busy.ts")], defaultModel: { provider: "busy", id: "m" },
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
  });
  server = await listen(host, join(root, "host.sock"));
  client = await HostClient.connect(join(root, "host.sock"));
});

after(async () => {
  client.close();
  await host.shutdown();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const idle = (id: string) => until(() => !host.runtime(id)?.session.isStreaming, 20_000, `${id} idle`);

test("a parent wakes its closed child through pi-host, the child replies, and a client can wake it too", async () => {
  const parent = await host.open({ name: "parent" });
  const child = await host.open({ name: "worker", identity: { name: "worker", role: "child", parentId: parent.sessionId, depth: 1 } });
  await host.runtime(child.sessionId)!.session.prompt("first task");
  await idle(child.sessionId);
  const file = host.runtime(child.sessionId)!.session.sessionFile!;
  await host.kill(child.sessionId);
  assert.equal(registry.get(child.sessionId), undefined);
  assert.equal(registry.dormantOf(child.sessionId)?.parentId, parent.sessionId);

  const list = (await kernelHandler(parent.sessionId, "agent_observe.list")!({})) as { agents: { sessionName: string; relationship: string; status: string }[] };
  assert.deepEqual(list.agents.map(a => [a.relationship, a.sessionName, a.status]), [["child", "worker", "inactive"]]);

  const receipt = (await kernelHandler(parent.sessionId, "agent_message.send")!({ message: "second task", receiver_role: "child", receiver_name: "worker" })) as { deliveryStatus: string };
  assert.equal(receipt.deliveryStatus, "delivered");
  assert.equal(host.runtime(child.sessionId)?.session.sessionFile, file, "the child reopened in its own file");
  assert.equal(registry.get(child.sessionId)?.role, "child");
  await idle(child.sessionId);
  const reply = (await kernelHandler(child.sessionId, "agent_message.send")!({ message: "done", receiver_role: "parent" })) as { deliveryStatus: string };
  assert.equal(reply.deliveryStatus, "delivered");
  assert.equal(repliedSinceTask(child.sessionId), true);
  await until(() => landed(host.runtime(parent.sessionId)!.session.sessionFile).some(m => m.header === "[agent-message from child:worker]"));
  await idle(parent.sessionId);

  await host.kill(child.sessionId);
  await client.call({ type: "send_message", targetActiveSessionId: child.sessionId, message: "from the chat" } as never);
  await idle(child.sessionId);
  const got = landed(file).map(m => [m.header, m.message]);
  assert.deepEqual(got.slice(0, 1), [["[agent-message from parent:parent]", "second task"]]);
  assert.equal(got[1][1], "from the chat");
});
