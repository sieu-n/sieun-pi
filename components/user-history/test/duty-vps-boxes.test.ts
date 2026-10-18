// Guards the owner's 10-18 split (msg mvdlv4yw): standing risks left the ops chat's plan (p45, p221) for a risk page that this duty counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FiringAlert } from "../src/alert-bridge.ts";
import { countRisks, parseRisks } from "../scripts/duties/vps-boxes.ts";

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
