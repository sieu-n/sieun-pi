import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { openRuntime } from "@sieun-pi/pi-testkit/faux";
import { createPoolExtension } from "../index.ts";
import { poolRetries, withPoolRetries } from "@sieun-pi/pi-family/retries";
import { fakeAnthropic, openAnthropic, rateLimited, type Answer } from "../check/rig.ts";

const FAKE = fileURLToPath(new URL("./fake-pool.mjs", import.meta.url));
let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-pool-rt-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

interface Rig { dir: string; calls(): { argv: string[]; key: string | null; protocol: string | null }[] }

/** A fresh fake pool and a runtime on a built-in Anthropic model that talks to a fake server. */
async function rig(name: string, state: Record<string, unknown>, answers: Answer[]) {
  const dir = join(root, name);
  mkdirSync(join(dir, "pool"), { recursive: true });
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 50 } }));
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["A", "B"], current: 0, ...state }));
  writeFileSync(join(dir, "pool", "turns.json"), "{}");
  process.env.FAKE_POOL_DIR = join(dir, "pool");
  const server = await fakeAnthropic(answers);
  const ext = createPoolExtension({ bin: FAKE, turnsFile: join(dir, "pool", "turns.json"), agentDir: join(dir, "agent") });
  const rt = await openAnthropic(dir, server.url, [ext]);
  const pool: Rig = {
    dir,
    calls: () => readFileSync(join(dir, "pool", "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
  return { rt, server, pool };
}


test("a run that meets four limited accounts in a row goes on to the fifth, and other errors keep Pi's budget", async () => {
  const { rt, server, pool } = await rig("fifth", { accounts: ["A", "B", "C", "D", "E"] }, [rateLimited(), rateLimited(), rateLimited(), rateLimited(), { status: 200, text: "from E" }]);
  const sid = rt.session.sessionManager.getSessionId();
  withPoolRetries(rt.session.settingsManager, sid);
  await rt.session.prompt("hi");
  assert.equal(rt.session.getLastAssistantText(), "from E");
  assert.deepEqual(server.seen.map(s => s.authorization), ["A", "B", "C", "D", "E"].map(a => `Bearer sk-ant-oat01-${a}`));
  assert.equal(pool.calls().filter(c => c.argv[1] === "limited").length, 4);
  assert.equal(poolRetries(sid), 0, "the reply that came through clears the count");
  await rt.dispose();
  await server.close();

  const busy = { status: 503, body: { type: "error", error: { type: "api_error", message: "Service unavailable" } } };
  const plain = await rig("budget", {}, [busy, busy, busy, busy, { status: 200, text: "too late" }]);
  withPoolRetries(plain.rt.session.settingsManager, plain.rt.session.sessionManager.getSessionId());
  await plain.rt.session.prompt("hi");
  assert.equal((plain.rt.session.messages.at(-1) as { stopReason?: string }).stopReason, "error", "four 503s still end the run after Pi's 3 retries");
  assert.equal(plain.server.seen.length, 4);
  await plain.rt.dispose();
  await plain.server.close();
});
