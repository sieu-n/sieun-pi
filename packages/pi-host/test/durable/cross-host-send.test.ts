/**
 * A thread's root reaches a thread root on another box with agent_message.send (rlm.ts `sendAcross`), driven through a real kernel cell:
 * 1. A sibling name or id this pi-host does not run goes to apps/chat's `POST /api/threads/:id/agent-message`, with the shared wire header
 *    that names the sender's full id, and the receipt names the target thread, its box and `crossHost`.
 * 2. A thread on a box that is away gives apps/chat's 503 text as the send's error.
 * 3. A name no box runs gives "No sibling matches" with apps/chat's 404 text.
 * 4. A local thread's name never reaches apps/chat.
 * On 11-25 a send from metal to 5180 designer's work thread on the Mac failed with "No sibling matches", because only this box's roots listed.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, lastText, results, rlmOptions, say } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-cross-host-send-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const MAC_WORK = "4f9dad47-ee36-446b-a689-7611335e0354";
const AWAY = "4f9dad47-0000-4000-8000-000000000002";

const posts: { thread: string; body: Record<string, unknown> }[] = [];
let chat: Server;
let rlm: DurableRlm;

before(async () => {
  await testPython();
  chat = createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const route = /^\/api\/threads\/([^/]+)\/agent-message$/.exec(req.url ?? "");
    if (req.method !== "POST" || !route) return reply(404, { error: `No endpoint ${req.method} ${req.url}.` });
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      posts.push({ thread: decodeURIComponent(route[1]!), body });
      if (body.to === MAC_WORK || body.to === "5180 designer") return reply(200, { thread: MAC_WORK, name: "5180 designer", box: "mac", submission: 7 });
      if (body.to === AWAY) return reply(503, { error: `vent (${AWAY}) on mac is away now, so the message was not sent; send it again once mac is back.` });
      reply(404, { error: `No thread on any box has the id or name ${JSON.stringify(body.to)}.` });
    });
  });
  await new Promise<void>(resolve => chat.listen(0, "127.0.0.1", resolve));
  rlm = await DurableRlm.load({ ...rlmOptions(dir), chatUrl: `http://127.0.0.1:${(chat.address() as { port: number }).port}` });
});

after(async () => {
  await rlm?.shutdown();
  chat?.close();
  rmSync(dir, { recursive: true, force: true });
});

const CODE = `
import json
async def attempt(name):
    try:
        r = await agent_message.send("hello from metal", receiver_role="sibling", receiver_name=name)
        return {"ok": r["target"]["sessionId"], "name": r["target"]["sessionName"], "host": r.get("host"), "crossHost": r.get("crossHost")}
    except Exception as e:
        return {"error": str(e)}
out = {}
for name in ["${MAC_WORK}", "5180 designer", "${AWAY}", "nobody", "local"]:
    out[name] = await attempt(name)
print(json.dumps(out))
`;

test("a sibling send to a thread on another box goes through apps/chat to that box, and an away box or unknown name says why", async () => {
  const threads = new DurableThreads({
    dir: join(dir, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 8 }, () => ({ messages }: { messages: Message[] }) => {
        if (messages.at(-1)?.role === "toolResult") return say("done");
        return lastText(messages) === "go" ? cell(CODE) : say("ok");
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
  const sender = await threads.create({ name: "agent factory" });
  const local = await threads.create({ name: "local" });
  const submitted = await threads.submit(sender.id, { text: "go" });
  await threads.wait(sender.id, submitted.submission);
  const { entries } = await threads.entries(sender.id, { conversation: 1, limit: 200 });
  await threads.shutdown();
  const cellOut = results(entries).find(r => r.name === "ipython");
  assert.ok(cellOut && !cellOut.isError, cellOut?.text);
  const out = JSON.parse(cellOut.text.trim().split("\n").at(-1)!) as Record<string, { ok?: string; name?: string; host?: string; crossHost?: boolean; error?: string }>;

  assert.deepEqual(out[MAC_WORK], { ok: MAC_WORK, name: "5180 designer", host: "mac", crossHost: true });
  assert.deepEqual(out["5180 designer"], { ok: MAC_WORK, name: "5180 designer", host: "mac", crossHost: true });
  assert.match(out[AWAY]!.error!, /on mac is away now, so the message was not sent/);
  assert.match(out.nobody!.error!, /No sibling matches "nobody" \(No thread on any box has the id or name "nobody"\.\)/);
  assert.equal(out.local!.ok, local.id);
  assert.equal(out.local!.crossHost, null);

  const header = `[agent-message from sibling:agent factory (${sender.id}, a pi-host thread); answer with agent_message.send(text, receiver_role="sibling", receiver_name="${sender.id}")]`;
  assert.deepEqual(posts.map(p => [p.thread, p.body.to, p.body.text, p.body.whenBusy]), [
    [sender.id, MAC_WORK, `${header}\n\nhello from metal`, "steer"],
    [sender.id, "5180 designer", `${header}\n\nhello from metal`, "steer"],
    [sender.id, AWAY, `${header}\n\nhello from metal`, "steer"],
    [sender.id, "nobody", `${header}\n\nhello from metal`, "steer"],
  ]);
  for (const post of posts) assert.match(String(post.body.requestId), /^agentmsg:/);
});
