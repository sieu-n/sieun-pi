// 10-23 on us-metal02: Prime 0.9.8 names a subagent's parent in its base prompt when it spawns it, and writes "your parent agent" when the
// daemon loads it again after an unload, so each reload changed the system prompt and wrote the child's whole prompt cache again (18 of the 42
// system prompt changes in the prompt captures from 16:46Z to 18:20Z). This runs the extension's real before_provider_request hook.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CHILD = "01a1694a-d619-703c-8ccf-328d37540888";
const prompt = (parent: string) => `You are the base prompt.\n\nYou are a child agent spawned by ${parent}. Task prompts are labeled \`[task from parent]\`.\nMore text.`;
const payload = (parent: string) => ({ model: "claude-opus-5-5", system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: prompt(parent), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "go" }] });

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One load of the extension for the child, over the session entries `entries` that its appendEntry calls extend. */
async function load(data: string, root: string, entries: { type: string; customType?: string; data?: unknown }[]) {
  const handlers = new Map<string, Handler[]>();
  const pi = new Proxy({}, { get: (_target, key) => {
    if (key === "on") return (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]);
    if (key === "appendEntry") return (customType: string, value: unknown) => entries.push({ type: "custom", customType, data: value });
    if (key === "getFlag") return (flag: string) => flag === "agent-chat-data-dir" ? data : undefined;
    if (key === "getActiveTools") return () => ["ipython"];
    return () => undefined;
  } });
  const { default: historyExtension } = await import(`../extension/index.ts?load=${Math.random()}`);
  historyExtension(pi as never);
  const ctx = { model: { provider: "anthropic", id: "claude-opus-5-5" }, sessionManager: { getSessionId: () => CHILD, getSessionName: () => "",
    getHeader: () => ({ type: "session", id: CHILD, rlmDepth: 1, parentSession: join(root, "missing-parent.jsonl") }), getEntries: () => entries,
    getBranch: () => entries, getSessionFile: () => join(root, `${CHILD}.jsonl`) } };
  return async (body: unknown): Promise<unknown> => {
    let current = body;
    for (const handler of handlers.get("before_provider_request") ?? []) current = await handler({ type: "before_provider_request", payload: current }, ctx) ?? current;
    return current;
  };
}

test("a subagent loaded again after an unload sends the parent name its first load sent", async t => {
  const root = mkdtempSync(join(tmpdir(), "parent-label-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.SIEUN_PI_HOSTS = join(root, "no-hosts.json");
  const data = join(root, "browser-chat");
  mkdirSync(data, { recursive: true });
  const entries: { type: string; customType?: string; data?: unknown }[] = [];
  const first = await load(data, root, entries);
  const sent = await first(payload("Crawler VP"));
  assert.deepEqual(sent, payload("Crawler VP"), "the first load sends Prime's payload as it is");
  const again = await load(data, root, entries);
  assert.deepEqual(await again(payload("your parent agent")), sent, "the reload's payload names the parent as before, so the cached prefix holds");
  const fresh = await load(data, root, []);
  assert.deepEqual(await fresh(payload("your parent agent")), payload("your parent agent"), "a child with no stored name keeps Prime's line");
});
