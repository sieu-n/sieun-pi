import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { About, ABOUT_FILE, aboutReport, parseVersions, type AboutBox } from "../../server/about.ts";
import { FIXTURE_ABOUT, FixtureHost } from "../../server/host/fixture.ts";
import { seedFixture } from "../../server/fixture/seed.ts";

/** What VERSIONS_COMMAND printed on the Mac on 11-25, which has no apps/chat and whose one daemon is not the default. */
const MAC_OUTPUT = [
  `piHost\trelease-8ceff51\t{  "sha": "8ceff51020b9667bdf0361adeb19a80083ed0f33",  "source": "/Users/sieunpark/Documents/Github/sieun-pi",  "builtAt": "2026-11-25T20:33:24.709Z"}`,
  "appsChat\t\t",
  `pi\t\t"version": "1.4.0",`,
  "vendored\t * Prime's harness digest code, copied verbatim from Prime's source at d5d28f65cf82b5d71a41eea1e583a5dc495871be * (0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-load.2.1-upd.3-load.3.9-test.51), the release the daemon ran when this file was made:",
  `prime\t"version":"0.9.8-darwin-test.51","isDefault":false`,
  "",
].join("\n");

const box = (name: string, output: string | Error, up = true): AboutBox & { calls: number } => {
  const entry = {
    box: name, up, calls: 0,
    check: async () => {
      entry.calls += 1;
      if (output instanceof Error) throw output;
      return { ok: true, output };
    },
  };
  return entry;
};

function dir(t: { after: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), "about-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("an up box reads every version, and the default daemon wins over the first", async t => {
  let now = 1_000;
  const about = new About(join(dir(t), ABOUT_FILE), async () => "1.6.1", () => now);
  const daemons = FIXTURE_ABOUT.metalOutput.replace(/^prime\t.*$/m, `prime\t"version":"old","isDefault":false,"version":"new","isDefault":true,`);
  const report = await about.report([box("us-metal02", daemons)]);
  assert.deepEqual(report.hosts, [{
    box: "us-metal02", state: "up", readAt: 1_000, error: null,
    versions: {
      pi: "1.4.0",
      piHost: { release: "release-8ceff51", sha: "8ceff51020b9667bdf0361adeb19a80083ed0f33", builtAt: "2026-11-25T20:31:22.299Z" },
      appsChat: { release: "release-37a7d69", sha: "37a7d69023c2a5e01f17cd6e6938edd791de38a1", builtAt: "2026-11-25T20:34:54.365Z" },
      primeVendored: { version: "0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-load.2.1-upd.3-load.3.9-test.51", sha: "d5d28f65cf82b5d71a41eea1e583a5dc495871be" },
      primeDaemon: "new",
    },
  }]);
  assert.deepEqual(report.piLatest, { version: "1.6.1", checkedAt: 1_000 });
  now = 2_000;
  assert.equal((await about.report([box("us-metal02", FIXTURE_ABOUT.metalOutput)])).hosts[0]!.versions!.primeDaemon, FIXTURE_ABOUT.macVersions.primeVendored.version);
});

test("a box without apps/chat reads null for it, and a lone non-default daemon still names its version", () => {
  const versions = parseVersions(MAC_OUTPUT);
  assert.equal(versions.appsChat, null);
  assert.equal(versions.primeDaemon, "0.9.8-darwin-test.51");
  assert.equal(versions.pi, "1.4.0");
  assert.equal(versions.piHost?.sha, "8ceff51020b9667bdf0361adeb19a80083ed0f33");
});

test("an away box keeps its last good read across a restart, and a failed read on an up box keeps it with the error", async t => {
  const file = join(dir(t), ABOUT_FILE);
  let now = 5_000;
  await new About(file, async () => "1.6.1", () => now).report([box("mac", MAC_OUTPUT)]);
  now = 9_000;
  const restarted = new About(file, async () => "1.6.1", () => now);
  const away = box("mac", MAC_OUTPUT, false);
  const [host] = (await restarted.report([away])).hosts;
  assert.equal(away.calls, 0);
  assert.deepEqual({ state: host!.state, readAt: host!.readAt, error: host!.error, appsChat: host!.versions?.appsChat }, { state: "away", readAt: 5_000, error: null, appsChat: null });
  assert.equal(host!.versions?.piHost?.release, "release-8ceff51");
  const [failed] = (await restarted.report([box("mac", new Error("relay call timed out"))])).hosts;
  assert.deepEqual({ state: failed!.state, readAt: failed!.readAt, error: failed!.error }, { state: "up", readAt: 5_000, error: "relay call timed out" });
  const [garbled] = (await restarted.report([box("mac", "sh: not found")])).hosts;
  assert.match(garbled!.error ?? "", /no piHost line: sh: not found/);
  const [never] = (await restarted.report([box("new-box", "", false)])).hosts;
  assert.deepEqual(never, { box: "new-box", state: "away", readAt: null, versions: null, error: null });
});

test("npm is read at most once an hour, a failed read waits the hour too, and the last version stays across a restart", async t => {
  const file = join(dir(t), ABOUT_FILE);
  let now = 0;
  const answers: Array<string | Error> = ["1.5.0", new Error("npm answered 503"), "1.6.1"];
  let reads = 0;
  const fetchLatest = async () => {
    const next = answers[reads++]!;
    if (next instanceof Error) throw next;
    return next;
  };
  const about = new About(file, fetchLatest, () => now);
  const [a, b] = await Promise.all([about.report([]), about.report([])]);
  assert.equal(reads, 1);
  assert.deepEqual([a.piLatest, b.piLatest], [{ version: "1.5.0", checkedAt: 0 }, { version: "1.5.0", checkedAt: 0 }]);
  now = 3_599_999;
  await about.report([]);
  assert.equal(reads, 1);
  now = 3_600_000;
  assert.deepEqual((await about.report([])).piLatest, { version: "1.5.0", checkedAt: 0 });
  assert.equal(reads, 2);
  now = 7_199_999;
  await about.report([]);
  assert.equal(reads, 2);
  assert.deepEqual((await new About(file, fetchLatest, () => now).report([])).piLatest, { version: "1.6.1", checkedAt: 7_199_999 });
  assert.equal(reads, 3);
  assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as { piLatest: unknown }).piLatest, { version: "1.6.1", checkedAt: 7_199_999 });
  now = 7_300_000;
  assert.deepEqual((await new About(file, fetchLatest, () => now).report([])).piLatest, { version: "1.6.1", checkedAt: 7_199_999 });
  assert.equal(reads, 3);
});

test("the fixture answers with us-metal02 up and the Mac away with its seeded last read", async t => {
  const data = dir(t);
  const host = new FixtureHost();
  seedFixture(host, data, 50_000_000, "us-metal02");
  const report = await aboutReport(host, "us-metal02", data);
  assert.deepEqual(report.hosts.map(h => [h.box, h.state, h.error]), [["us-metal02", "up", null], ["mac", "away", null]]);
  assert.equal(report.hosts[0]!.versions?.appsChat?.release, "release-37a7d69");
  assert.deepEqual(report.hosts[1]!.versions, FIXTURE_ABOUT.macVersions);
  assert.equal(report.hosts[1]!.readAt, 50_000_000 - 3 * 3_600_000);
  assert.equal(report.piLatest?.version, "1.6.1");
});
