// Guards the owner's 10-18 split (msg mvdlv4yw): standing risks left the ops chat's plan (p45, p221) for a risk page that this duty counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FiringAlert } from "../src/alert-bridge.ts";
import { readFile } from "node:fs/promises";
import { DUTY_FILE, countRisks, oomKills24h, parseExplained, parseRisks, splitOomLines } from "../scripts/duties/vps-boxes.ts";

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

// Guards 10-26: metal-host-disk-fill-30d fired on us-metal01's / and /ci, and the cold-disk risk read as firing with /hdd.raid10 at 7.6 TB free.
test("a risk's match narrows a shared rule to its own labels, and an alert without the label still counts", () => {
  const file = parseRisks({ risks: [
    { id: "cold", line: "us-metal01 cold disk fills", owner: "metal", alertUids: ["metal-host-disk-fill-30d", "metal-disk-raid-pd-failed"], match: { mountpoint: "/hdd\\.raid10" } },
  ] });
  const disk = (mountpoint: string): FiringAlert => ({ ...alert("metal-host-disk-fill-30d", "2026-10-26T15:18:00.000Z"), labels: { __alert_rule_uid__: "metal-host-disk-fill-30d", mountpoint } });
  const known = new Set(["metal-host-disk-fill-30d", "metal-disk-raid-pd-failed"]);
  assert.equal(countRisks(file, [disk("/"), disk("/ci")], known, 0).firing, 0);
  assert.equal(countRisks(file, [disk("/hdd.raid10")], known, 0).firing, 1);
  assert.equal(countRisks(file, [alert("metal-disk-raid-pd-failed", "2026-10-26T00:00:00.000Z")], known, 0).firing, 1);
});

// Guards p456 (10-19): us-metal02 had 40 OOM kills from 13:14Z to 16:52Z and no duty counted them, so the 24 h hold after the fixes had no owner.
test("oom_kills_24h sums both boxes, names each box with a kill and its last kill, flags a /proc/vmstat fallback, and fails when a box is missing", () => {
  const last = Date.parse("2026-10-19T16:52:00Z");
  const result = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 42, lastAt: last }], 0);
  assert.equal(result.kills, 42);
  assert.deepEqual(result.flagged.map(slice => slice.excerpt), ["us-metal02: 42 OOM kills outside heavy scopes in the last 24 h, the last kill of any kind at about 16:52Z on 10-19"]);
  const fallback = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 45, sinceBootAt: Date.parse("2026-10-14T20:47:00Z") }], 0);
  assert.match(fallback.flagged[0]!.excerpt, /us-metal02: 45 OOM kills outside heavy scopes in \/proc\/vmstat since its boot at 20:47Z on 10-14/);
  assert.deepEqual(oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 0 }], 0), { kills: 0, heavy: 0, explained: 0, flagged: [] });
  assert.throws(() => oomKills24h([{ box: "us-metal01", kills: 0 }], 0), /no node_vmstat_oom_kill of us-metal02/);
});

// Guards the ops chat's 10-19 check-in: two 8G heavy scopes died at 17:26Z and 17:27Z with memory pressure full 0.00, so a kill a job's own
// MemoryMax caused counts apart as heavy_scope_kills, and oom_kills_24h counts only the kills outside heavy scopes.
test("a kill inside a heavy scope counts as heavy_scope_kills, a slice line only echoes a kill below it, and any other unit counts as outside", () => {
  const starts = [
    "Started run-p436970-i92146936.scope - [systemd-run] /usr/bin/choom -n 500 -- bash /home/sieun/scratch/connect-push-10-20/fullcheck.sh.",
    "Started run-p904848-i92945148.scope - [systemd-run] /usr/bin/choom -n 500 -- npx jest --ci.",
    "Started run-p1-i2.scope - [systemd-run] /usr/bin/node build.mjs.",
  ].join("\n");
  const line = (at: number, unit: string) => `${at}.5 us-metal02 systemd[257985]: ${unit}: The kernel OOM killer killed some processes in this unit.`;
  const journal = [line(1792430774, "run-p436970-i92146936.scope"), line(1792430848, "app.slice"), line(1792430861, "run-p904848-i92945148.scope"),
    line(1792430901, "-.slice")].join("\n");
  assert.deepEqual(splitOomLines(journal, starts), { heavy: 2, units: [] });
  const heavyOnly = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 2, ...splitOomLines(journal, starts) }], 0);
  assert.equal(heavyOnly.kills, 0);
  assert.equal(heavyOnly.heavy, 2);
  assert.deepEqual(heavyOnly.flagged.map(slice => slice.kind), ["oom_heavy"]);
  const mixed = splitOomLines([journal, line(1792430990, "prime-agent-daemon.service"), line(1792430991, "run-p1-i2.scope")].join("\n"), starts);
  assert.deepEqual(mixed, { heavy: 2, units: ["prime-agent-daemon.service", "run-p1-i2.scope"], outsideAt: 1792430991000 });
  const outside = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 4, ...mixed }], 0);
  assert.equal(outside.kills, 2);
  assert.match(outside.flagged[0]!.excerpt, /^us-metal02: 2 OOM kills outside heavy scopes and 2 more inside heavy scopes in the last 24 h; the journal names prime-agent-daemon.service, run-p1-i2.scope$/);
});

// Guards p468 (10-20): p456 fixed the us-metal02 kills up to 16:52Z on 10-19, yet they held oom_kills_24h at 41 for a whole day and the duty
// asked for a new job each run, so the kills a fix step explains count apart as oom_kills_explained.
test("oom_kills_24h leaves out the kills up to the newest until a fix step explains, names that step, and counts a newer kill outside", () => {
  const explained = parseExplained({ explainedKills: [{ box: "us-metal02", until: "2026-10-19T10:00:00Z", step: "p400" },
    { box: "us-metal02", until: "2026-10-19T16:52:00Z", step: "p456" }] });
  const by = explained.get("us-metal02")!;
  assert.deepEqual(by, { box: "us-metal02", until: Date.parse("2026-10-19T16:52:00Z"), step: "p456" });
  assert.throws(() => parseExplained({ explainedKills: [{ box: "us-metal02", until: "soon", step: "p456" }] }), /explainedKills 0 needs/);
  assert.equal(parseExplained({}).size, 0);
  const held = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 46, explained: 41, heavy: 5, by }], 0);
  assert.deepEqual([held.kills, held.heavy, held.explained], [0, 5, 41]);
  assert.deepEqual(held.flagged.map(slice => slice.excerpt), ["us-metal02: no OOM kill outside heavy scopes (5 inside) since 16:52Z on 10-19; p456 explains the 41 kills up to 16:52Z on 10-19"]);
  const newer = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 43, explained: 41, units: ["sf-bill-q.service"], by }], 0);
  assert.equal(newer.kills, 2);
  assert.equal(newer.flagged[0]!.kind, "oom");
  assert.match(newer.flagged[0]!.excerpt, /^us-metal02: 2 OOM kills outside heavy scopes since 16:52Z on 10-19; the journal names sf-bill-q.service; p456 explains the 41 kills/);
});

test("the checked-in duty file names p557 for the us-metal02 kills up to 15:14:52Z on 10-27 and p490 for the us-metal01 backup kill at 22:08Z on 10-21", async () => {
  const explained = parseExplained(JSON.parse(await readFile(DUTY_FILE, "utf8")));
  assert.equal(explained.get("us-metal02")?.step, "p557");
  assert.equal(explained.get("us-metal01")?.step, "p490");
});

// AI harness d9 read oom_kills_24h as a lagging window on 10-22 because the precheck gave no lastEventAt, so it could not tell a count of
// old kills from a fresh one. This checks the count is dated by its newest counted kill, and a count of 0 gives no date.
test("oom_kills_24h's lastEventAt is its newest counted kill: the journal's outside line, else Prometheus' last kill, else this run", () => {
  const at = Date.parse("2026-10-22T08:00:00Z");
  const journal = Date.parse("2026-10-22T03:10:00Z");
  const prometheus = Date.parse("2026-10-22T05:40:00Z");
  const both = oomKills24h([{ box: "us-metal01", kills: 1, lastAt: prometheus }, { box: "us-metal02", kills: 3, heavy: 1, lastAt: at - 60_000, outsideAt: journal }], at);
  assert.equal(both.kills, 3);
  assert.equal(both.lastEventAt, prometheus);
  const procOnly = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 2, sinceBootAt: at - 86_400_000 }], at);
  assert.equal(procOnly.lastEventAt, at);
  const heavyOnly = oomKills24h([{ box: "us-metal01", kills: 0 }, { box: "us-metal02", kills: 2, heavy: 2, lastAt: prometheus }], at);
  assert.equal(heavyOnly.kills, 0);
  assert.equal(heavyOnly.lastEventAt, undefined);
  const explained = oomKills24h([{ box: "us-metal01", kills: 1, explained: 1, lastAt: prometheus, by: { box: "us-metal01", until: prometheus, step: "p490" } },
    { box: "us-metal02", kills: 0 }], at);
  assert.equal(explained.lastEventAt, undefined);
});
