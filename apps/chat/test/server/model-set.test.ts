/**
 * The server keeps who set an agent's model, so the fable auditor's sweep leaves out a Fable agent the owner chose (11-28: it flagged agent
 * factory for the Fable 5.2 he had set from his page at 19:19 KST):
 * 1. The owner's own PATCH of an agent's DM or work thread, or his Create agent, records him on the model it runs; a call from the box,
 *    with no owner login or with one of the box's own addresses as the caller, records nobody.
 * 2. His record holds while that model runs: a new model from a caller on the box drops it, and a model pi-host took another way reads
 *    as nobody's.
 * 3. POST /api/agents/:id/model-set adopts a PATCH of his that the request log holds, and refuses one it does not hold or one a caller
 *    on the box followed with its own PATCH.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/model-set.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentRecord } from "../../server/agent-store.ts";
import { agentSummary } from "../../server/agents.ts";
import { dayOf } from "../../server/request-log.ts";
import { modelRef } from "../../server/threads.ts";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

const FABLE = "anthropic/claude-fable-5-2";
const OPUS = "anthropic/claude-opus-5-5";
const OWNER = { "tailscale-user-login": "owner@example.com" };
let s: Running;

before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const call = async <T = any>(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const response = await fetch(s.base + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
};
const make = async (name: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<AgentSummary & { room: string }> =>
  (await call<AgentSummary & { room: string }>("POST", "/api/agents", { name, test: true, ...extra }, headers)).body;
const agent = async (id: string): Promise<AgentSummary> => (await s.get<AgentSummary[]>("/api/agents?test=1")).find(one => one.id === id)!;
const patch = async (id: string, body: unknown, headers: Record<string, string> = {}): Promise<void> => {
  assert.equal((await call("PATCH", `/api/c/${id}`, body, headers)).status, 200);
};

test("the owner's own PATCH records him as the setter of the agent's model, and a call from the box records nobody", async () => {
  const made = await make("Setter probe");
  assert.equal(made.modelSet, undefined, "made by a call from the box");

  await patch(made.room, { model: FABLE });
  assert.equal((await agent(made.id)).model?.id, "claude-fable-5-2");
  assert.equal((await agent(made.id)).modelSet, undefined, "a job's or a script's call carries no owner login");

  // A job's box Chrome on the tailnet URL carries his login too, with one of the box's own addresses as the caller (p278).
  const own = Object.values(networkInterfaces()).flatMap(list => list ?? []).find(one => !one.internal)?.address ?? "127.0.0.1";
  await patch(made.room, { thinkingLevel: "xhigh" }, { ...OWNER, "x-forwarded-for": own });
  assert.equal((await agent(made.id)).modelSet, undefined, "a browser on the box is not the owner");

  const from = Date.now();
  await patch(made.room, { model: FABLE, thinkingLevel: "high" }, OWNER);
  const set = (await agent(made.id)).modelSet;
  assert.equal(set?.by, "owner");
  assert.ok(set!.at >= from && set!.at <= Date.now());
  assert.deepEqual(s.app.agents.record(made.id)!.modelSet, { by: "owner", at: set!.at, model: FABLE });
});

test("his record holds while his model runs: a thinking level from the box keeps it and a new model from the box drops it", async () => {
  const made = await make("Setter keep probe");
  // His PATCH of the work thread itself counts as his PATCH of the DM does.
  await patch(made.thread, { model: FABLE }, OWNER);
  assert.equal((await agent(made.id)).modelSet?.by, "owner");

  await patch(made.room, { thinkingLevel: "medium" });
  assert.equal((await agent(made.id)).modelSet?.by, "owner", "the model is still the one he set");

  await patch(made.room, { model: OPUS });
  await patch(made.room, { model: FABLE });
  assert.equal((await agent(made.id)).model?.id, "claude-fable-5-2");
  assert.equal((await agent(made.id)).modelSet, undefined, "an agent's own switch back to Fable is not his");
  assert.equal(s.app.agents.record(made.id)!.modelSet, undefined);

  // A model pi-host took with no PATCH here, such as a job's own call to it, is nobody's.
  const record: AgentRecord = { ...s.app.agents.record(made.id)!, modelSet: { by: "owner", at: 1, model: OPUS } };
  const summary = (model: string) => agentSummary(record, { tree: [], jobs: [] }, { model: modelRef(model), rooms: [] });
  assert.deepEqual(summary(OPUS).modelSet, { by: "owner", at: 1 });
  assert.equal(summary(FABLE).modelSet, undefined);
});

test("an agent the owner makes from his page runs the model he chose", async () => {
  const from = Date.now();
  const made = await make("Setter create probe", { model: FABLE, thinkingLevel: "high" }, OWNER);
  assert.equal(made.modelSet?.by, "owner");
  assert.ok(s.app.agents.record(made.id)!.modelSet!.at >= from);
  assert.equal(s.app.agents.record(made.id)!.modelSet!.model, FABLE);
});

test("model-set adopts a PATCH of the owner's that the request log holds, and refuses any other", async () => {
  const made = await make("Setter adopt probe", { model: FABLE });
  const dir = join(s.app.config.dataDir, "requests");
  mkdirSync(dir, { recursive: true });
  const at = Date.now() - 60_000;
  const line = (extra: Record<string, unknown>) => `${JSON.stringify({ at, src: "server", m: "PATCH", r: "/api/c/:id", p: `/api/c/${made.room}`, s: 200, ms: 40, via: "tailnet", ...extra })}\n`;
  const adopt = (id: string, when: unknown) => call<AgentSummary & { error?: string }>("POST", `/api/agents/${id}/model-set`, { at: when });

  assert.equal((await adopt(made.id, at)).status, 400, "the log holds no PATCH of his yet");
  writeFileSync(join(dir, `${dayOf(at)}.jsonl`), line({ at: at - 5, via: "local", ua: "node" }) + line({ at: at - 3, s: 400 }) + line({ at: at - 1, p: "/api/c/dm_other" }), { flag: "a" });
  assert.equal((await adopt(made.id, at - 5)).status, 400, "a PATCH from the box is not his");
  assert.equal((await adopt(made.id, at - 3)).status, 400, "a refused PATCH changed nothing");
  assert.equal((await adopt(made.id, at - 1)).status, 400, "a PATCH of another agent");
  assert.equal((await adopt(made.id, "19:19")).status, 400);
  assert.equal((await adopt("ag_nobody", at)).status, 404);
  assert.equal((await agent(made.id)).modelSet, undefined);

  writeFileSync(join(dir, `${dayOf(at)}.jsonl`), line({}), { flag: "a" });
  const adopted = await adopt(made.id, at);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.deepEqual(adopted.body.modelSet, { by: "owner", at });
  assert.deepEqual(s.app.agents.record(made.id)!.modelSet, { by: "owner", at, model: FABLE });

  const other = await make("Setter late probe", { model: FABLE });
  const late = { p: `/api/c/${other.room}` };
  writeFileSync(join(dir, `${dayOf(at)}.jsonl`), line(late) + line({ ...late, at: at + 1000, via: "local", ua: "node" }), { flag: "a" });
  const refused = await adopt(other.id, at);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error ?? "", /after the owner's/);
  assert.equal((await agent(other.id)).modelSet, undefined);
});
