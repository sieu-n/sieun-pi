// Guards d7's reading of a timed-out send whose session waited for a pi-pool slot (src/slot-wait-timeouts.ts). On 10-18 the outbox's send to
// frontend bro on the Mac at 13:01:33.205Z timed out after 30 s and landed at 13:02:43.704Z, after the session queued for a working slot at
// 13:01:27.426Z, while its worker kept writing (/home/sieun/work/mac-slowlink/RESULT.md). Before, that timeout made 13:02Z a daemon fault.
// The lines are service.log on us-metal02 and the Mac's session files as this box's copies held them, with long content cut to "[cut]".
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import { deliveryCandidates, outboxLandings, readSessionMarks, splitSlotWaits, transcriptMarks } from "../src/slot-wait-timeouts.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const FRONTEND_LOG = [
  "2026-10-18T13:01:41.656Z duty 01a11ba8/checkin: skipped, skipped: previous run still working (job check-in frontend bro 21:46)",
  "2026-10-18T13:02:03.222Z outbox 01a11ba8: m-faf97e47-2242-486c-8a5b-60926e05a3df try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.",
  "chat 01a11ba8: handed p209 back to the chat: job onboarding walk fixes reported with them open",
  "2026-10-18T13:03:10.090Z outbox 01a11ba8: m-faf97e47-2242-486c-8a5b-60926e05a3df is landed from the send at 2026-10-18T13:01:33.205Z; not sent again",
];
// frontend bro's file, 01a11ba8-9d2c-727c-8ded-38f819ca9f29.jsonl, from the prompt before the send to the queue after it.
const FRONTEND_FILE = [
  "{\"type\":\"message\",\"id\":\"69dc2c75\",\"parentId\":\"eab20a7f\",\"timestamp\":\"2026-10-18T13:01:21.218Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[job] onboarding walk fixes reported, and its open step is yours now: p209 \\\"Five onboarding proposals, each from a different real-world…\\\". Close or continue p209.\"}],\"timestamp\":1792328468241}}",
  "{\"type\":\"custom\",\"customType\":\"pi-pool-queue\",\"data\":{\"text\":\"Queued for a working slot, 1st of 3\",\"position\":1,\"total\":3,\"at\":1792328487426},\"id\":\"363aad56\",\"parentId\":\"69dc2c75\",\"timestamp\":\"2026-10-18T13:01:27.426Z\"}",
  "{\"type\":\"child_usage_attributed\",\"id\":\"eafaed86\",\"parentId\":\"363aad56\",\"timestamp\":\"2026-10-18T13:01:35.970Z\",\"targetId\":\"2d929bd8\",\"origin\":\"agent_message\"}",
  "{\"type\":\"child_usage_attributed\",\"id\":\"c25f3ca3\",\"parentId\":\"eafaed86\",\"timestamp\":\"2026-10-18T13:02:03.991Z\",\"targetId\":\"2d929bd8\",\"origin\":\"direct_user\"}",
  "{\"type\":\"message\",\"id\":\"28912223\",\"parentId\":\"c25f3ca3\",\"timestamp\":\"2026-10-18T13:02:12.034Z\",\"message\":{\"role\":\"assistant\",\"content\":\"[cut]\",\"stopReason\":\"toolUse\"}}",
  "{\"type\":\"message\",\"id\":\"0724253e\",\"parentId\":\"28912223\",\"timestamp\":\"2026-10-18T13:02:35.586Z\",\"message\":{\"role\":\"toolResult\",\"content\":\"[cut]\"}}",
  "{\"type\":\"message\",\"id\":\"afe3efa5\",\"parentId\":\"0724253e\",\"timestamp\":\"2026-10-18T13:02:40.975Z\",\"message\":{\"role\":\"toolResult\",\"content\":\"[cut]\"}}",
  "{\"type\":\"custom_message\",\"customType\":\"agent_message\",\"content\":\"[cut]\",\"display\":true,\"details\":\"[cut]\",\"id\":\"d07fcae3\",\"parentId\":\"afe3efa5\",\"timestamp\":\"2026-10-18T13:02:43.704Z\"}",
  "{\"type\":\"custom\",\"customType\":\"pi-pool-queue\",\"data\":{\"text\":\"Queued for a working slot, 1st of 2\",\"position\":1,\"total\":2,\"at\":1792328571264},\"id\":\"e6c7a560\",\"parentId\":\"d07fcae3\",\"timestamp\":\"2026-10-18T13:02:51.264Z\"}",
  "{\"type\":\"child_usage_attributed\",\"id\":\"98ee6bc8\",\"parentId\":\"e6c7a560\",\"timestamp\":\"2026-10-18T13:02:51.342Z\",\"targetId\":\"2d929bd8\",\"origin\":\"agent_message\"}",
];
// engage fix relay (01a14e21) had last written at 10:49:08Z after a failed turn; the daemon later had no such session and the message was dropped.
const SILENT_LOG = [
  "2026-10-18T11:36:21.261Z outbox 01a14e21: m-420641d5-0cb3-4745-814c-a30f9d1609a9 try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.",
  "2026-10-18T11:37:02.120Z outbox 01a14e21: m-420641d5-0cb3-4745-814c-a30f9d1609a9 try 2 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.",
  "2026-10-18T11:37:29.573Z messages: 01a14e21 is not a session the daemon has or can reopen; message m-420641d5-0cb3-4745-814c-a30f9d1609a9 dropped",
];
const SILENT_FILE = [
  "{\"type\":\"message\",\"id\":\"3cd3b32b\",\"parentId\":\"8c4f6cb5\",\"timestamp\":\"2026-10-18T10:48:24.269Z\",\"message\":{\"role\":\"assistant\",\"content\":\"[cut]\",\"stopReason\":\"error\"}}",
  "{\"type\":\"agent_status\",\"id\":\"4b84f113\",\"parentId\":\"3cd3b32b\",\"timestamp\":\"2026-10-18T10:49:08.342Z\",\"status\":{\"summary\":\"Model request failed: Failed to resolve API key for provider \\\"anthropic\\\" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token pi-pool: the token hook gave no token;…\",\"taskState\":\"error\",\"basedOnMessageCount\":3}}",
];

const FRONTEND = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const chats = [{ id: FRONTEND, name: "frontend bro", duties: [], runs: [] }];
const watchUntil = (run: number): WatchLine[] => Array.from({ length: 30 }, (_, minute) => ({ at: new Date(run - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(),
  host: "us-metal02", usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 }));

const split = (log: string[], files: Record<string, string[]>) => {
  const faults = readServiceFaults(log, "us-metal02");
  return splitSlotWaits(faults, outboxLandings(log), fault => files[fault.session!.slice(0, 8)] && transcriptMarks(files[fault.session!.slice(0, 8)]!));
};

test("frontend bro's file shows its slot wait from the queue entry to the next assistant message", () => {
  const marks = transcriptMarks(FRONTEND_FILE);
  assert.deepEqual(marks.slotWaits.map(wait => [new Date(wait.from).toISOString(), wait.to && new Date(wait.to).toISOString()]),
    [["2026-10-18T13:01:27.426Z", "2026-10-18T13:02:12.034Z"], ["2026-10-18T13:02:51.264Z", undefined]]);
  assert.equal(marks.writes.length, FRONTEND_FILE.length);
});

test("the 13:01Z send that landed after a slot wait is a queue wait, and 13:02Z stays clean", () => {
  const { faults, slotWaits } = split(FRONTEND_LOG, { "01a11ba8": FRONTEND_FILE });
  assert.deepEqual(faults, []);
  assert.equal(slotWaits.length, 1);
  assert.equal(slotWaits[0]!.how, "landed");
  assert.equal(slotWaits[0]!.deliveredAt - slotWaits[0]!.sentAt, Date.parse("2026-10-18T13:03:10.090Z") - Date.parse("2026-10-18T13:01:33.222Z"));
  const now = Date.parse("2026-10-18T13:10:10Z");
  const { metrics, flagged } = measure({ now, watch: watchUntil(now), log: { holds: [] }, chats, daemonFaults: faults, slotWaits });
  assert.equal(metrics.daemon_fail_min_30, 0);
  assert.equal(metrics.clean_min_30, 30);
  assert.equal(metrics.slot_wait_timeouts_30, 1);
  assert.equal(flagged?.find(slice => slice.kind === "slot_wait_timeout")?.excerpt,
    "13:02Z frontend bro on mac: an outbox send failed, send_message timed out after 30 s, while it waited for a pi-pool slot from 13:01Z, and the outbox found its message landed 97 s after it went; a queue wait, not a daemon fault.");
});

test("the same send with no slot wait in the file stays a daemon fault", () => {
  const { faults, slotWaits } = split(FRONTEND_LOG, { "01a11ba8": FRONTEND_FILE.filter(line => !line.includes("pi-pool-queue")) });
  assert.equal(faults.length, 1);
  assert.deepEqual(slotWaits, []);
});

test("a send that timed out with no landing and no write after it stays a daemon fault", () => {
  const { faults, slotWaits } = split(SILENT_LOG, { "01a14e21": SILENT_FILE });
  assert.deepEqual(faults.map(fault => `${fault.session} ${fault.host} ${fault.what}`), [
    "01a14e21 mac an outbox send failed, send_message timed out after 30 s",
    "01a14e21 mac an outbox send failed, send_message timed out after 30 s",
  ]);
  assert.deepEqual(slotWaits, []);
  const now = Date.parse("2026-10-18T11:40:10Z");
  assert.equal(measure({ now, watch: watchUntil(now), log: { holds: [] }, chats, daemonFaults: faults, slotWaits }).metrics.daemon_fail_min_30, 2);
});

test("the precheck reads only the files of sessions with a timed-out send or status read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slot-wait-"));
  const file = join(dir, `${FRONTEND}.jsonl`);
  await writeFile(file, FRONTEND_FILE.join("\n") + "\n");
  const faults = readServiceFaults(FRONTEND_LOG, "mac").map(fault => ({ ...fault, host: "mac" }));
  const asked: string[] = [];
  const marks = await readSessionMarks(deliveryCandidates(faults), short => { asked.push(short); return file; }, "mac", Date.parse("2026-10-18T13:10:10Z"));
  assert.deepEqual(asked, ["01a11ba8"]);
  assert.equal(marks.get("01a11ba8")?.slotWaits.length, 2);
});
