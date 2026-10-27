import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { openRuntime } from "../../pi-testkit/faux.ts";
import { createPoolExtension } from "../index.ts";
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


test("Stop during the working-slot wait ends the turn as stopped, not as an error", async () => {
  const { rt, server, pool } = await rig("queue-stop", { queuedTimes: 1000 }, []);
  const prompt = rt.session.prompt("hi");
  setTimeout(() => void rt.session.abort(), 1500);
  await prompt;
  const last = rt.session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
  assert.equal(server.seen.length, 0, "no request went out");
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "aborted", `ended as ${last.stopReason}: ${last.errorMessage}`);
  assert.doesNotMatch(last.errorMessage ?? "", /operation was aborted/);
  const sid = rt.session.sessionManager.getSessionId();
  assert.ok(pool.calls().some(c => c.argv[1] === "release" && c.argv[2] === sid), "the queue entry was released");
  await rt.dispose();
  await server.close();
});
