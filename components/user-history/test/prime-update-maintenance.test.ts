// Replays 19:47Z to 20:17Z on 10-25 on us-metal02, the run d7 flagged at 20:17:47Z with clean_min_30 at 28. The crc.1 update's coordinator
// (ctl pid 2424745) recorded its restart of the daemon from 20:10:11Z to 20:12:35Z. Its prepare made the wake's open of "crawler worker memory
// peak" answer "Active session 680443071bdf is recovering; retry shortly" at 20:10:21Z, and two outbox sends the new supervisor took 30 s to
// answer while it restored 42 sessions landed on their first try at 20:10:53Z. The service log keeps 20:10:17Z to 20:11:33Z without the
// batched sends' id lists, the watch lines keep host, at, usable, queue, hosts, chat and mac, and the record drops its continuations.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { readUpdateSpans, updateSpan } from "../src/prime-update.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const watch = fixture("prime-update-1025-2010.watch.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line) as WatchLine);
const service = fixture("prime-update-1025-2010.service.txt").split("\n");
const record = JSON.parse(fixture("prime-update-1025-2010.record.json")) as unknown;
const RUN = Date.parse("2026-10-25T20:17:47.036Z");
const run = (primeUpdates?: Parameters<typeof measure>[0]["primeUpdates"]) =>
  measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults: readServiceFaults(service, "us-metal02"), ...primeUpdates ? { primeUpdates } : {} });

test("an update coordinator's record reads as the span from its start to its last write", async () => {
  const window = { requestId: "2429267-1792959011469", from: Date.parse("2026-10-25T20:10:11.469Z"), to: Date.parse("2026-10-25T20:12:35.162Z") };
  assert.deepEqual(updateSpan(record), window);
  assert.equal(updateSpan({ ...record as object, phase: "failed" }), null, "a failed update stays a fault");
  const agentDir = mkdtempSync(join(tmpdir(), "prime-update-"));
  mkdirSync(join(agentDir, "update-restarts"));
  writeFileSync(join(agentDir, "update-restarts", "ctl-2424745-1792959010.json"), JSON.stringify(record));
  writeFileSync(join(agentDir, "update-restarts", "ctl-2424745-1792959010.planned.json"), JSON.stringify({ manifests: {} }));
  assert.deepEqual(await readUpdateSpans(agentDir), [window]);
});

test("d7 books the calls inside the crc.1 update of 10-25 as planned maintenance, and 20:10Z and 20:11Z run clean", () => {
  const before = run();
  assert.equal(before.metrics.clean_min_30, 28, "without the record both minutes read dirty, as the 20:17Z run did");
  const window = updateSpan(record)!;
  const { metrics, flagged } = run([{ ...window, host: "us-metal02" }]);
  assert.equal(metrics.clean_min_30, 30);
  assert.equal(metrics.daemon_fail_min_30, 0);
  assert.equal(metrics.prime_update_min_30, 3);
  assert.equal(flagged?.find(slice => slice.kind === "dirty_minutes"), undefined);
  assert.match(flagged?.find(slice => slice.kind === "prime_update")?.excerpt ?? "",
    /^Prime update 2429267-1792959011469 restarted the us-metal02 daemon from 20:10Z to 20:12Z; 3 daemon calls .* count as planned maintenance, not dirty \(.*680443071bdf is recovering/);
});

test("an update on another box leaves this box's faults dirty", () => {
  const { metrics } = run([{ ...updateSpan(record)!, host: "mac" }]);
  assert.equal(metrics.clean_min_30, 28);
});
