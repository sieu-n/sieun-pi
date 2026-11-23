/**
 * The agent.ref sweep logs a box's failing writes once, and once more when they work again. While the Mac slept on 11-22 the server logged
 * one "not written" line per thread on every 2 s sweep, about 43,000 lines a day.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-ref-log.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_REF_DOC } from "../../server/agent-folder.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until } from "./helpers.ts";

test("a box whose agent.ref writes fail logs once while each sweep tries again, and once when they work", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-ref-log-"));
  const lines: string[] = [];
  const running = await start({ dataDir, log: line => lines.push(line) });
  try {
    const h = running.host as FixtureHost;
    await until(async () => h.threadsById.get(ids.vent)?.docs.get(AGENT_REF_DOC), ref => ref !== undefined);
    await running.app.agents.sweepRefs();
    const vent = h.threadsById.get(ids.vent)!;
    const harness = h.threadsById.get(ids.harness)!;
    vent.docs.delete(AGENT_REF_DOC);
    harness.docs.delete(AGENT_REF_DOC);
    // The kept refs would skip both threads, so a move to another box makes the sweep read them again.
    const records = [running.app.agents.record("ag_vent")!, running.app.agents.record("ag_ai-harness-developer-environment-vp")!];
    for (const record of records) record.host = "sleeping-mac";

    const get = h.docGet.bind(h);
    let offline = true;
    const tries: string[] = [];
    h.docGet = async (thread, name) => {
      if (name === AGENT_REF_DOC && (thread === ids.vent || thread === ids.harness)) {
        tries.push(thread);
        if (offline) throw new Error("sleeping-mac is offline");
      }
      return get(thread, name);
    };
    const refLines = () => lines.filter(line => line.startsWith("agent.ref"));
    const before = refLines().length;
    for (let i = 0; i < 5; i++) await running.app.agents.sweepRefs();
    assert.ok(tries.length >= 10, `each sweep tried both threads again (${tries.length} tries)`);
    assert.deepEqual(refLines().slice(before).map(line => line.split(" fail,")[0]), ["agent.ref writes on sleeping-mac"]);

    offline = false;
    await running.app.agents.sweepRefs();
    assert.ok(vent.docs.get(AGENT_REF_DOC) && harness.docs.get(AGENT_REF_DOC), "both refs are written once the box answers");
    assert.deepEqual(refLines().slice(before + 1), ["agent.ref writes on sleeping-mac work again"]);
    h.docGet = get;
  } finally {
    await running.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
