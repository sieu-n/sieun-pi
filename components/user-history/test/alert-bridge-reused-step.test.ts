// Guards 10-18: ops guy removed the closed CLIProxy and CPU steps p370 and p371, reconcile put the NVMe write and latency alerts back as p370 and p371, and a refire of either old rule would have rewritten the NVMe steps' notes.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, parseAlerts, ruleKey, type BridgeState } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { findItem } from "../src/shared/chat-board.ts";

const OPS = ALERT_ROUTES.find(route => route.chat === "ops guy")!.session;
const NOW = Date.parse("2026-10-18T09:20:00Z");
const raw = (fingerprint: string, uid: string, alertname: string, startsAt: string) => ({ fingerprint, startsAt, annotations: { summary: `${alertname} is firing.` },
  labels: { alertname, __alert_rule_uid__: uid, box: "us-metal01" }, generatorURL: `https://obs.virev.ai/alerting/grafana/${uid}/view`, status: { state: "active" } });
const cliproxy = raw("c1c1c1c1c1c1c1c1", "cliproxy-claude-wire", "Claude wire through CLIProxy not answering 200", "2026-10-18T09:17:00.000Z");
const nvme = raw("a0a0a0a0a0a0a0a0", "metal-host-nvme0-writes-4tb", "us-metal01 nvme0n1 wrote over 4 TB in 24 hours", "2026-10-15T21:48:00.000Z");

test("a rule whose removed step id the board gave to another rule's step gets its own step when it fires again, and the other step's note stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alert-reused-id-"));
  const file = join(dir, "alert-bridge.json");
  const boards = new BoardStore(dir);
  let now = NOW;
  let list: unknown[] = [cliproxy];
  const bridge = new AlertBridge({ file, boards, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => null,
    deliver: async () => {} });
  const state = async () => JSON.parse(await readFile(file, "utf8")) as BridgeState;
  const item = async (id: string) => findItem((await boards.read(OPS))!.plan, id)?.item;

  await bridge.tick();
  const old = (await state()).rules[ruleKey(OPS, "cliproxy-claude-wire")]!.step!;
  now += 60_000; list = [];
  await bridge.tick();
  await boards.apply(OPS, [{ op: "plan_remove", id: old }], "agent");
  now += 60_000; list = [nvme];
  await bridge.tick();
  assert.equal((await state()).rules[ruleKey(OPS, "metal-host-nvme0-writes-4tb")]!.step, old, "the board reuses the removed id");
  const nvmeNote = (await item(old))!.note;

  now += 60_000; list = [nvme, cliproxy];
  await bridge.tick();
  assert.equal((await item(old))!.note, nvmeNote);
  assert.equal((await item(old))!.text, "us-metal01 nvme0n1 wrote over 4 TB in 24 hours");
  const own = (await state()).rules[ruleKey(OPS, "cliproxy-claude-wire")]!.step!;
  assert.notEqual(own, old);
  assert.equal((await item(own))!.text, "Claude wire through CLIProxy not answering 200");
  assert.match((await item(own))!.note!, /^Grafana alert rule cliproxy-claude-wire, firing since 2026-10-18T09:17:00\.000Z\.$/m);
});
