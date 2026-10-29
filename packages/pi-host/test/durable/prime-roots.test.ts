/**
 * A durable thread's root reaches Prime root sessions (`prime-roots.ts`), driven through a real kernel cell in DurableThreads:
 * 1. agent_observe.list_agents lists the other pi threads and the Prime roots as siblings, each with its kind, box and status: this box's
 *    live top-level roots from a fake Prime daemon (no subagent, rlm child or archived row) named as the chat names them, and the other box's
 *    from a fake chat service.
 * 2. agent_message.send to a Prime root by its full id or exact name goes to the chat service's api/agent/notice with the write token and
 *    origin, and its first line is the shared wire header that names the pi thread's full id.
 * 3. An id prefix matches nothing, and a name that a pi thread and a Prime root share is ambiguous, with both full ids in the error.
 * 4. agent_observe.get_agent and recent_messages on a Prime root give its row and no messages.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { PrimeRoots } from "../../src/durable/prime-roots.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, lastText, results, rlmOptions, say } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-roots-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const OWNER = "01aaaaaa-0000-7000-8000-000000000001";
const RELEASE = "01aaaaaa-0000-7000-8000-000000000002";
const FABLE = "01bbbbbb-0000-7000-8000-000000000003";
const MAC_VENT = "01bbbbbb-0000-7000-8000-000000000004";
const TOKEN = "csrf-test-token";
const CAPABILITY = "cap-test";

/** This box's live roster as Prime's daemon lists it: two roots, and a subagent, an rlm child and an archived root that stay out. */
const ROSTER = [
  { sessionId: OWNER, activeSessionId: "aaaa00000001", sessionName: "metal box owner", lifecycle: "live", activity: "working", runtimeKind: "top-level" },
  { sessionId: RELEASE, activeSessionId: "aaaa00000002", firstMessage: "<provider_quota_resumed> a later message", lifecycle: "live", activity: "idle", runtimeKind: "top-level" },
  { sessionId: "01aaaaaa-0000-7000-8000-000000000005", sessionName: "a job", lifecycle: "live", activity: "idle", runtimeKind: "subagent" },
  { sessionId: "01aaaaaa-0000-7000-8000-000000000006", sessionName: "a kid", lifecycle: "live", activity: "idle", rlmChildId: "sub-1", rlmDepth: 1 },
  { sessionId: "01aaaaaa-0000-7000-8000-000000000007", sessionName: "old chat", lifecycle: "archived", activity: "idle", runtimeKind: "top-level" },
];
/** The chat service's siblings of a root: the roots on every box but that root's, named as its catalog names them. */
const SIBLINGS: Record<string, { sessionId: string; activeSessionId?: string; sessionName: string; status: string; host: string }[]> = {
  [OWNER]: [
    { sessionId: FABLE, activeSessionId: "bbbb00000003", sessionName: "Fable", status: "working", host: "mac" },
    { sessionId: MAC_VENT, sessionName: "vent", status: "idle", host: "mac" },
  ],
  [FABLE]: [
    { sessionId: OWNER, sessionName: "metal box owner", status: "working", host: "box-a" },
    { sessionId: RELEASE, sessionName: "release owner", status: "idle", host: "box-a" },
    { sessionId: "01aaaaaa-0000-7000-8000-000000000008", sessionName: "a saved root", status: "idle", host: "box-a" },
  ],
};

const notices: { body: Record<string, unknown>; token: unknown; origin: unknown }[] = [];
let daemon: Server;
let chat: HttpServer;
let rlm: DurableRlm;
let primeRoots: PrimeRoots;

before(async () => {
  await testPython();
  const socket = join(dir, "prime.sock");
  daemon = createServer(conn => {
    conn.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`);
    let buffer = "";
    conn.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, nl)) as { type: string; id: string; command: { type: string; id: string } };
        buffer = buffer.slice(nl + 1);
        // Prime takes only enveloped commands (protocol 7).
        const ok = line.type === "command" && line.command.type === "list";
        conn.write(`${JSON.stringify(ok ? { type: "response", id: line.command.id, success: true, data: { sessions: ROSTER } } : { type: "response", id: line.id, success: false, error: "Daemon commands require protocol 7 or newer" })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socket, resolve));
  chat = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === `/${CAPABILITY}/api/agent/siblings`) {
      const roots = SIBLINGS[url.searchParams.get("session") ?? ""];
      return roots ? reply(200, { agents: roots.map(root => ({ ...root, runtimeKind: "top-level", relationship: "sibling", crossHost: true })) }) : reply(404, { error: "No box lists root session." });
    }
    if (req.method === "POST" && url.pathname === `/${CAPABILITY}/api/agent/notice`) {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        notices.push({ body: parsed, token: req.headers["x-chat-token"], origin: req.headers.origin });
        reply(200, { deliveryStatus: "queued", session: parsed.to });
      });
      return;
    }
    reply(404, { error: "not found" });
  });
  await new Promise<void>(resolve => chat.listen(0, "127.0.0.1", resolve));
  const port = (chat.address() as { port: number }).port;
  const chatDir = join(dir, "browser-chat");
  mkdirSync(chatDir);
  writeFileSync(join(chatDir, "configuration.json"), JSON.stringify({ csrfToken: TOKEN, port, capability: CAPABILITY }));
  const host = (name: string, box: string, daemonSocket: string, roles: Record<string, unknown>) =>
    ({ name, hostname: box, address: "127.0.0.1", relayPort: 7790, token: "file:relay-token", daemonSocket, ssh: null, roles });
  const hostsFile = join(dir, "hosts.json");
  writeFileSync(hostsFile, JSON.stringify({ version: 1, hosts: [host("box-a", hostname(), socket, { chat: { port } }), host("mac", "not-this-box", "/tmp/no-such.sock", {})] }));
  process.env.SIEUN_PI_HOSTS = hostsFile;
  rlm = await DurableRlm.load(rlmOptions(dir));
  primeRoots = new PrimeRoots({ hostsFile, chatDataDir: chatDir });
});

after(async () => {
  await rlm?.shutdown();
  daemon?.close();
  chat?.close();
  rmSync(dir, { recursive: true, force: true });
});

const CODE = `
import json
out = {}
listed = await agent_observe.list_agents()
out["agents"] = [{k: a.get(k) for k in ("sessionId", "sessionName", "relationship", "kind", "host", "status")} for a in listed["agents"]]
out["missing"] = listed.get("missing")
async def attempt(name):
    try:
        r = await agent_message.send("hello from pi", receiver_role="sibling", receiver_name=name)
        return {"ok": r["target"]["sessionId"], "host": r.get("host")}
    except Exception as e:
        return {"error": str(e)}
out["sends"] = {}
for name in ["${FABLE}", "release owner", "bbbb00000003", "${FABLE.slice(0, 13)}", "vent"]:
    out["sends"][name] = await attempt(name)
got = await agent_observe.get_agent("${FABLE}")
got = got.get("agent", got)
recent = await agent_observe.recent_messages("${FABLE}")
out["get"] = {k: got.get(k) for k in ("sessionId", "kind", "host", "status")}
out["recent"] = [len(recent["messages"]), recent["agent"]["sessionName"]]
print(json.dumps(out))
`;

test("a thread's root lists Prime roots as siblings and sends to one by full id or exact name through the chat service's outbox", async () => {
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
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm,
    primeRoots,
  });
  const sender = await threads.create({ name: "sender" });
  const vent = await threads.create({ name: "vent" });
  const submitted = await threads.submit(sender.id, { text: "go" });
  await threads.wait(sender.id, submitted.submission);
  const { entries } = await threads.entries(sender.id, { conversation: 1, limit: 200 });
  await threads.shutdown();
  const cellOut = results(entries).find(r => r.name === "ipython");
  assert.ok(cellOut && !cellOut.isError, cellOut?.text);
  const out = JSON.parse(cellOut.text.trim().split("\n").at(-1)!) as {
    agents: { sessionId: string; sessionName: string; relationship: string; kind: string; host: string | null; status: string }[];
    missing: string | null; sends: Record<string, { ok?: string; host?: string; error?: string }>;
    get: Record<string, string>; recent: [number, string];
  };

  assert.equal(out.missing, null);
  const rows = Object.fromEntries(out.agents.map(a => [a.sessionId, [a.sessionName, a.relationship, a.kind, a.host, a.status]]));
  assert.deepEqual(rows, {
    [vent.id]: ["vent", "sibling", "pi", null, "idle"],
    [OWNER]: ["metal box owner", "sibling", "prime", "box-a", "running"],
    [RELEASE]: ["release owner", "sibling", "prime", "box-a", "idle"],
    [FABLE]: ["Fable", "sibling", "prime", "mac", "running"],
    [MAC_VENT]: ["vent", "sibling", "prime", "mac", "idle"],
  });

  assert.deepEqual(out.sends[FABLE], { ok: FABLE, host: "mac" });
  assert.deepEqual(out.sends["release owner"], { ok: RELEASE, host: "box-a" });
  assert.deepEqual(out.sends["bbbb00000003"], { ok: FABLE, host: "mac" });
  assert.match(out.sends[FABLE.slice(0, 13)]!.error!, new RegExp(`No sibling matches "${FABLE.slice(0, 13)}"`));
  const ambiguous = out.sends.vent!.error!;
  assert.match(ambiguous, /sibling selector "vent" is ambiguous/);
  assert.ok(ambiguous.includes(`vent (${vent.id}, a pi-host thread)`), ambiguous);
  assert.ok(ambiguous.includes(`vent (${MAC_VENT}, a Prime session on mac)`), ambiguous);

  const header = `[agent-message from sibling:sender (${sender.id}, a pi-host thread); answer with agent_message.send(text, receiver_role="sibling", receiver_name="${sender.id}")]`;
  assert.deepEqual(notices.map(n => [n.body.to, n.body.root, n.body.message, n.token, n.origin]), [
    [FABLE, FABLE, `${header}\n\nhello from pi`, TOKEN, `http://127.0.0.1:${(chat.address() as { port: number }).port}`],
    [RELEASE, RELEASE, `${header}\n\nhello from pi`, TOKEN, `http://127.0.0.1:${(chat.address() as { port: number }).port}`],
    [FABLE, FABLE, `${header}\n\nhello from pi`, TOKEN, `http://127.0.0.1:${(chat.address() as { port: number }).port}`],
  ]);

  assert.deepEqual(out.get, { sessionId: FABLE, kind: "prime", host: "mac", status: "running" });
  assert.deepEqual(out.recent, [0, "Fable"]);
});
