// Guards the owner's 10-18 split (msg mvdlv4yw): standing risks left the ops chat's plan (p45, p221) for a risk page that this duty counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FiringAlert } from "../src/alert-bridge.ts";
import { countRisks, diskDaysMin, parseRisks } from "../scripts/duties/vps-boxes.ts";

const alert = (uid: string, startsAt: string): FiringAlert =>
  ({ fingerprint: `${uid}-${startsAt}`, startsAt, alertname: uid, labels: { __alert_rule_uid__: uid }, summary: "", url: "" });

test("a risk counts once however many of its label sets fire, and a risk with no rule or an unknown uid is flagged", () => {
  const file = parseRisks({ risks: [
    { id: "disk", line: "us-metal01 root disk fills", owner: "metal", alertUids: ["metal-host-disk-fill-30d", "metal-host-disk-85"] },
    { id: "wire", line: "Claude wire through CLIProxy", owner: "cliproxy probe", alertUids: ["cliproxy-claude-wire"] },
    { id: "oom", line: "us-metal02 OOM kills", owner: "box-memory-guard", alertUids: [] },
    { id: "typo", line: "WAL archive failing", owner: "metal", alertUids: ["metal-backup-wal-faild"] },
  ] });
  const firing = [alert("metal-host-disk-fill-30d", "2026-10-18T07:45:00.000Z"), alert("metal-host-disk-fill-30d", "2026-10-17T07:45:00.000Z"), alert("other", "2026-10-18T00:00:00.000Z")];
  const result = countRisks(file, firing, new Set(["metal-host-disk-fill-30d", "metal-host-disk-85", "cliproxy-claude-wire"]), 0);
  assert.equal(result.firing, 1);
  assert.deepEqual(result.flagged.map(slice => slice.kind), ["firing", "unchecked", "gap"]);
  assert.match(result.flagged[0]!.excerpt, /owner metal\): metal-host-disk-fill-30d firing since 2026-10-17T07:45/);
});

// Guards 10-19: root_disk_days read us-metal01's / only (51 days) while us-metal02's / read 6.9, so disk_days_min reads every disk of both boxes.
test("disk_days_min is the lowest disk of both boxes, names each disk under 30 days, and fails when a box has no disk", () => {
  const disks = [{ box: "us-metal01", mountpoint: "/", days: 50.9 }, { box: "us-metal01", mountpoint: "/ci", days: 15.47 }, { box: "us-metal02", mountpoint: "/", days: 6.93 }];
  const result = diskDaysMin(disks, 0);
  assert.equal(result.days, 6.9);
  assert.equal(result.flagged.excerpt, "fills within 30 days at the last 24 h rate: us-metal02's / (6.9 days), us-metal01's /ci (15.5 days)");
  assert.match(diskDaysMin([{ box: "us-metal01", mountpoint: "/", days: 50.9 }, { box: "us-metal02", mountpoint: "/drive2", days: 71.8 }], 0).flagged.excerpt, /lowest is us-metal01's \/ \(50.9 days\)/);
  assert.throws(() => diskDaysMin(disks.slice(0, 2), 0), /no disk of us-metal02/);
});
