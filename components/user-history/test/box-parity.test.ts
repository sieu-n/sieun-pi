// Owner 10-18 (goal p1): us-metal02 matches the owner's MacBook Pro for every tool; these cases pin how the Box tools parity duty judges a row, a limit and port 22.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitGaps, compareVersions, containerLimits, foldName, judgeRows, type LimitContext, managerLimits, parseLayers, parseShow, type ProbeOutput, publicSsh, type Row, shortfall, unitLimits, unpushedNote }
  from "../scripts/duties/box-parity.ts";

const output = (host: "mac" | "box", values: Record<string, string[]>): ProbeOutput => ({ host, values, versions: {}, ms: 1 });

test("shortfall takes the Mac as the standard and lets a box set hold more", () => {
  assert.equal(shortfall("v:10.33.0", "v:10.33.0"), null);
  assert.equal(shortfall("v:10.33.0", "v:10.32.1"), "Mac v:10.33.0, box v:10.32.1");
  assert.equal(shortfall("absent", "absent"), null);
  assert.equal(shortfall("fail: token invalid", "fail: nope"), null);
  assert.equal(shortfall('set:["a","b"]', 'set:["a","b","c"]'), null);
  assert.equal(shortfall('set:["a","b"]', 'set:["a"]'), "box lacks 1 of the Mac's 2: b");
  assert.equal(shortfall("ok", undefined), "the box gave no value");
});

test("shortfall counts a Mac commit as on the box under another hash by patch-id or written bytes, and keeps a real miss off", () => {
  const mac = `commits:${JSON.stringify([
    ["aaaaaaaaaa", "p-same-hash", ["k1"]],
    ["bbbbbbbbbb", "p-rebased", ["k-other-base"]],
    ["cccccccccc", "", ["k-page-1", "k-page-2"]],
    ["dddddddddd", "p-mac-only", ["k-page-1", "k-mac-only"]],
  ])}`;
  const box = `commits:${JSON.stringify({ ids: ["aaaaaaaaaa", "eeeeeeeeee"], patches: ["p-rebased"], bytes: ["k1", "k-page-1", "k-page-2"] })}`;
  const lacks = "box lacks 1 of the Mac's 4, which the Mac pushed, so a fetch on the box gets them: ";
  assert.equal(shortfall(mac, box), `${lacks}dddddddddd`);
  assert.equal(shortfall(mac, `commits:${JSON.stringify({ ids: [], patches: ["p-rebased", "p-mac-only"], bytes: ["k-page-1", "k-page-2"] })}`), `${lacks}aaaaaaaaaa`);
  assert.equal(shortfall(mac, "fail: git log: bad"), "the Mac gave its commits, box fail: git log: bad");
});

test("a Mac commit on a branch the box fetched is on the box, and one the Mac never pushed is mac_unpushed and not counted", () => {
  const mac = `commits:${JSON.stringify([
    ["aaaaaaaaaa", "p-fetched", ["k-a"], true],
    ["bbbbbbbbbb", "p-not-fetched", ["k-b"], true],
    ["cccccccccc", "p-local", ["k-c"], false],
    ["dddddddddd", "p-local-shared", ["k-d"], false],
  ])}`;
  const box = `commits:${JSON.stringify({ ids: [], patches: ["p-local-shared"], bytes: [], fetched: ["aaaaaaaaaa"] })}`;
  assert.deepEqual(commitGaps(mac, box), { missing: ["bbbbbbbbbb"], unpushed: ["cccccccccc"], total: 4 });
  assert.equal(shortfall(mac, box), "box lacks 1 of the Mac's 4, which the Mac pushed, so a fetch on the box gets them: bbbbbbbbbb");
  assert.equal(unpushedNote(mac, box), "the Mac has 1 of its last 4 commits on its branch unpushed to origin, so the box cannot fetch them: cccccccccc");
  const row: Row = { id: "tip", tool: "checkout tip", probes: [{ tip: true }] };
  const fetchedAll = `commits:${JSON.stringify({ ids: [], patches: ["p-local-shared"], bytes: [], fetched: ["aaaaaaaaaa", "bbbbbbbbbb"] })}`;
  const result = judgeRows([row], output("mac", { tip: [mac] }), output("box", { tip: [fetchedAll] }), new Map());
  assert.equal(result.off.length, 0);
  assert.equal(result.matched, 1);
  assert.match(result.unpushed[0]!.why, /1 of its last 4 .*cccccccccc/);
});

test("shortfall lets a box CLI version be newer than the Mac's and keeps an older one off", () => {
  assert.equal(shortfall("v:1.7.1", "v:1.8.1"), null);
  assert.equal(shortfall("v:18.3", "v:18.6"), null);
  assert.equal(shortfall("v:8.1", "v:8.1.1"), null);
  assert.equal(shortfall("v:8.6.2", "v:8.0.5"), "Mac v:8.6.2, box v:8.0.5");
  assert.equal(shortfall("v:3.6a", "v:3.6"), "Mac v:3.6a, box v:3.6");
  assert.equal(shortfall("v:2.54.0", "v:2.53.0"), "Mac v:2.54.0, box v:2.53.0");
  assert.equal(shortfall("v:8.1.1", "fail: no version in x"), "Mac v:8.1.1, box fail: no version in x");
  assert.equal(compareVersions("3.6a", "3.6b"), -1);
  assert.equal(compareVersions("10.33.0", "10.4.9"), 1);
  assert.equal(compareVersions("26.07.0", "26.7"), 0);
});

test("judgeRows counts misses, folds in panel outcomes and keeps intended and by-design rows out of the count", () => {
  const rows: Row[] = [
    { id: "pnpm", tool: "cli pnpm", probes: [{ version: ["pnpm", "--version"] }] },
    { id: "poppler", tool: "cli pdftotext", probes: [{ version: ["pdftotext", "-v"], intended: "no Linux build" }] },
    { id: "hermes", tool: "cli hermes", probes: [{ which: "hermes" }], byDesign: "Mac-only agent" },
    { id: "panel", tool: "tools-panel check gh_auth", mac: [{ const: "ok" }], box: [{ panel: "gh_auth" }] },
    { id: "panel-off", tool: "tools-panel check aside_tabs", mac: [{ const: "ok" }], box: [{ panel: "aside_tabs" }] },
  ];
  const mac = output("mac", { pnpm: ["v:10.33.0"], poppler: ["v:26.08.0"], hermes: ["ok"], panel: ["ok"], "panel-off": ["ok"] });
  const box = output("box", { pnpm: ["v:10.32.1"], poppler: ["v:26.07.0"], hermes: ["absent"], panel: ["panel"], "panel-off": ["panel"] });
  const panel = new Map([["gh_auth", { status: "fail" as const, fixer: "agent" as const, detail: "not logged in", fix: "log in" }],
    ["aside_tabs", { status: "off" as const, detail: "the Mac is asleep" }]]);
  const result = judgeRows(rows, mac, box, panel);
  assert.deepEqual(result.off.map(verdict => verdict.row.id), ["pnpm", "panel"]);
  assert.match(result.off[1]!.why, /not logged in/);
  assert.deepEqual(result.intended.map(verdict => verdict.row.id), ["poppler"]);
  assert.deepEqual(result.byDesign.map(verdict => verdict.row.id), ["hermes"]);
  assert.equal(result.matched, 3);
});

test("judgeRows takes a panel fail that the probe's shared text names as a match, and still counts any other fail", () => {
  const rows: Row[] = [{ id: "search", tool: "tools-panel check websearch_query", mac: [{ const: "ok" }], box: [{ panel: "websearch_query", shared: "Google is down on the Virev" }] }];
  const mac = output("mac", { search: ["ok"] });
  const box = output("box", { search: ["panel"] });
  const fail = (detail: string) => new Map([["websearch_query", { status: "fail" as const, fixer: "agent" as const, detail, fix: "x" }]]);
  assert.equal(judgeRows(rows, mac, box, fail("Google is down on the Virev search backend; results came from the DuckDuckGo fallback")).off.length, 0);
  assert.deepEqual(judgeRows(rows, mac, box, fail("Virev search error (500)")).off.map(verdict => verdict.row.id), ["search"]);
});

const deploy = join(import.meta.dirname, "../../../deploy/linux");
const layers = parseLayers(readFileSync(join(deploy, "cpu/setup-cpu.sh"), "utf8"), readFileSync(join(deploy, "cpu/cpu-protect.py"), "utf8"),
  readFileSync(join(deploy, "memory/heavy"), "utf8"), 1001);
const context = (files: Record<string, string>, nice: Record<number, number> = {}, scope: "system" | "user" = "user"): LimitContext =>
  ({ scope, defaultTasksMax: "272774", memTotal: 1000, layers, read: path => files[path], niceOf: pid => nice[pid] });

test("unitLimits counts our unit files and runtime settings, and skips vendor files, defaults and RAM-sized limits", () => {
  const ours = { Id: "box-textfile.service", FragmentPath: "/home/sieun/.config/systemd/user/box-textfile.service", Nice: "10", IOSchedulingClass: "3", TasksMax: "272774" };
  assert.deepEqual(unitLimits(ours, context({ [ours.FragmentPath]: "[Service]\nNice=10\nIOSchedulingClass=idle\n" })).map(finding => finding.key),
    ["user box-textfile.service Nice", "user box-textfile.service IOSchedulingClass"]);
  const vendor = { Id: "logrotate.service", FragmentPath: "/usr/lib/systemd/system/logrotate.service", Nice: "19" };
  assert.deepEqual(unitLimits(vendor, context({ [vendor.FragmentPath]: "Nice=19\n" })), []);
  const docker = { Id: "docker-abc.scope", FragmentPath: "/run/systemd/transient/docker-abc.scope", MemoryMax: "1000" };
  assert.deepEqual(unitLimits(docker, context({})), []);
  const guest = { Id: "machine-qemu\\x2d513\\x2dci\\x2dg9.scope", FragmentPath: "/run/systemd/transient/x.scope", TasksMax: "16384" };
  assert.deepEqual(unitLimits(guest, context({ "/run/systemd/transient/x.scope": "TasksMax=16384\n" })), []);
  const runtime = { Id: "ci.slice", MemoryHigh: "500" };
  assert.match(unitLimits(runtime, context({}))[0]!.excerpt, /sets MemoryHigh \(MemoryHigh=500\) at runtime/);
  const wrapped = { Id: "r3g-collect.service", ActiveState: "active", MainPID: "42", Nice: "0" };
  assert.match(unitLimits(wrapped, context({}, { 42: 10 }))[0]!.excerpt, /main process 42 runs at nice 10/);
});

test("unitLimits lists a setting the deploy/linux layer scripts set as owner-asked, and counts one that differs from them (owner's t84 answer 10-19)", () => {
  assert.equal(layers.weights.get("system user@1001.service"), "300");
  assert.equal(layers.weights.get("user sieun-pi-chat.service"), "1000");
  assert.deepEqual([layers.nice, layers.heavy], [{ unit: "prime-agent-daemon.service", value: -10 }, { swapMax: "0", score: 500 }]);
  const asked = (unit: Record<string, string>, ...rest: Parameters<typeof context>) => unitLimits(unit, context(...rest)).map(finding => [finding.key, Boolean(finding.ownerAsked)]);
  const dropin = "/etc/systemd/system/ssh.service.d/cpu-weight.conf";
  assert.deepEqual(asked({ Id: "ssh.service", DropInPaths: dropin, CPUWeight: "1000" }, { [dropin]: "CPUWeight=1000\n" }, {}, "system"), [["system ssh.service CPUWeight", true]]);
  assert.deepEqual(asked({ Id: "ssh.service", DropInPaths: dropin, CPUWeight: "500" }, { [dropin]: "CPUWeight=500\n" }, {}, "system"), [["system ssh.service CPUWeight", false]]);
  assert.deepEqual(asked({ Id: "ssh.service", CPUWeight: "1000" }, {}, {}, "user"), [["user ssh.service CPUWeight", false]]);
  assert.deepEqual(asked({ Id: "user@1001.service", CPUWeight: "300" }, {}, {}, "system"), [["system user@N.service CPUWeight", true]]);
  assert.deepEqual(asked({ Id: "dev.slice", CPUWeight: "300" }, {}, {}, "system"), [["system dev.slice CPUWeight", false]]);
  const daemon = { Id: "prime-agent-daemon.service", ActiveState: "active", MainPID: "7", Nice: "0", CPUWeight: "300" };
  assert.deepEqual(asked(daemon, {}, { 7: -10 }), [["user prime-agent-daemon.service CPUWeight", true], ["user prime-agent-daemon.service nice", true]]);
  assert.deepEqual(asked({ ...daemon, CPUWeight: "[not set]" }, {}, { 7: -5 }), [["user prime-agent-daemon.service nice", false]]);
  const chat = unitLimits({ ...daemon, Id: "sieun-pi-chat.service", CPUWeight: "[not set]" }, context({}, { 7: -10 }));
  assert.equal(chat[0]!.ownerAsked, undefined);
  const heavy = { Id: "run-p904848-i92945148.scope", Description: "[systemd-run] /usr/bin/choom -n 500 -- npx jest --ci", MemoryMax: "800", MemorySwapMax: "0" };
  const both = (ownerAsked: boolean) => [["user run-pN-iN.scope MemoryMax", ownerAsked], ["user run-pN-iN.scope MemorySwapMax", ownerAsked]];
  assert.deepEqual(asked(heavy, {}), both(true));
  assert.match(unitLimits(heavy, context({}))[0]!.ownerAsked!, /`heavy` sets it as memory layer 4/);
  assert.deepEqual(asked({ ...heavy, Description: "[systemd-run] npx jest --ci" }, {}), both(false));
  assert.deepEqual(asked({ ...heavy, MemorySwapMax: "100" }, {}), both(false));
  assert.deepEqual(asked(heavy, {}, {}, "system"), [["system run-pN-iN.scope MemoryMax", false], ["system run-pN-iN.scope MemorySwapMax", false]]);
});

test("parseLayers refuses a layer script whose shape it does not know", () => {
  assert.throws(() => parseLayers("declare -A OTHER=([a]=1)\n", "", "", 1001), /no SYSTEM_WEIGHTS table/);
  const cpu = "declare -A SYSTEM_WEIGHTS=([a]=1)\ndeclare -A USER_WEIGHTS=([b]=2)\n";
  assert.throws(() => parseLayers(cpu, "DAEMON = \"x\"\n", "", 1001), /no DAEMON or CORE_NICE/);
  assert.throws(() => parseLayers(cpu, "DAEMON = \"x\"\nCORE_NICE = -10\n", "exec systemd-run --user --scope -- \"$@\"\n", 1001), /heavy has no systemd-run/);
});

test("foldName folds instance numbers and ids so one setting on many units counts once", () => {
  assert.equal(foldName("machine-qemu\\x2d534\\x2dci\\x2dg7.scope"), "machine-qemu-N-ci-gN.scope");
  assert.equal(foldName("docker-0050f625d5dca8df1bc7f113a45c2ce6.scope"), "docker-<id>.scope");
  assert.equal(foldName("r3g-collect.service"), "r3g-collect.service");
});

test("containerLimits and managerLimits name only real caps", () => {
  const findings = containerLimits([{ Name: "/a", HostConfig: { Memory: 1000, CpuShares: 1024, PidsLimit: null } }, { Name: "/b", HostConfig: { NanoCpus: 2e9 } }], 1000);
  assert.deepEqual(findings.map(finding => finding.key), ["docker b NanoCpus"]);
  assert.deepEqual(managerLimits([{ path: "/etc/systemd/system.conf", text: "#DefaultTasksMax=15%\nDefaultTasksMax=infinity\nDefaultMemoryMax=4G\n" }]).map(finding => finding.key),
    ["manager /etc/systemd/system.conf DefaultMemoryMax"]);
});

test("publicSsh needs a refused control port to call 22 closed", () => {
  const on = { ActiveState: "active", Result: "success" };
  assert.equal(publicSsh({ ssh: "dropped", control: "refused" }, on).value, 0);
  assert.equal(publicSsh({ ssh: "open", control: "refused" }, on).value, 1);
  assert.equal(publicSsh({ ssh: "dropped", control: "dropped" }, on).value, undefined);
  assert.equal(publicSsh(new Error("ssh failed"), { ActiveState: "inactive", Result: "success" }).value, 1);
});

test("the probe runs a version row with a cwd on the Mac, since a pinned packageManager there wins over the installed version", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-"));
  const pkg = join(home, ".local/lib/node_modules/pnpm");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(home, "repo"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.0" }));
  writeFileSync(join(pkg, "bin/pnpm.cjs"), "#!/bin/sh\nif [ -f package.json ]; then echo 10.32.1; else echo 10.33.0; fi\n", { mode: 0o755 });
  symlinkSync(join(pkg, "bin/pnpm.cjs"), join(home, ".local/bin/pnpm"));
  writeFileSync(join(home, "repo/package.json"), JSON.stringify({ packageManager: "pnpm@10.32.1" }));
  const rows: Row[] = [{ id: "repo", tool: "cli pnpm", probes: [{ version: ["pnpm", "--version"], cwd: "~/repo" }] },
    { id: "bare", tool: "cli pnpm", probes: [{ version: ["pnpm", "--version"] }] }];
  const arg = Buffer.from(JSON.stringify({ host: "mac", rows, known: {} })).toString("base64");
  const out = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../scripts/duties/box-parity-probe.py"), arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as ProbeOutput;
  assert.deepEqual([out.values.repo, out.values.bare], [["v:10.32.1"], ["v:10.33.0"]]);
});

test("parseShow splits systemctl show records", () => {
  assert.deepEqual(parseShow("Id=a.service\nNice=0\n\nId=b.slice\nTasksMax=infinity\n"), [{ Id: "a.service", Nice: "0" }, { Id: "b.slice", TasksMax: "infinity" }]);
});

test("the probe reads files on the Mac side and refuses calls there", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-"));
  mkdirSync(join(home, "skills/a"), { recursive: true });
  writeFileSync(join(home, "skills/a/SKILL.md"), "x");
  const rows: Row[] = [{ id: "skill", tool: "skill a", probes: [{ path: "~/skills/a/SKILL.md" }, { ls: "~/skills" }, { path: "~/skills/b/SKILL.md" }] },
    { id: "call", tool: "cli gh", mac: [{ run: ["gh", "auth", "status"] }], box: [{ const: "ok" }] }];
  const arg = Buffer.from(JSON.stringify({ host: "mac", rows, known: {} })).toString("base64");
  const out = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../scripts/duties/box-parity-probe.py"), arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as ProbeOutput;
  assert.deepEqual(out.values.skill, ["ok", 'set:["a"]', "absent"]);
  assert.match(out.values.call![0]!, /^fail: run is not a read/);
});

test("a glob with atTip names only files in folders the host's tip holds, so a deleted app's leftover env file is no gap", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-attip-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  for (const app of ["web", "gone"]) mkdirSync(join(repo, "apps", app), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "sieun/dev");
  writeFileSync(join(repo, "apps/web/package.json"), "{}");
  git("add", "apps/web/package.json");
  git("commit", "-q", "-m", "web");
  for (const file of ["apps/web/.env.local", "apps/gone/.env.local", ".env"]) writeFileSync(join(repo, file), "x");
  const probes = [{ glob: "~/Documents/Github/auto-sns-agent/apps/*/.env*", names: true, atTip: true }, { glob: "~/Documents/Github/auto-sns-agent/.env*", names: true, atTip: true },
    { glob: "~/Documents/Github/auto-sns-agent/apps/*/.env*", names: true }];
  const arg = Buffer.from(JSON.stringify({ host: "box", rows: [{ id: "env", tool: "env files", probes }], known: {} })).toString("base64");
  const out = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../scripts/duties/box-parity-probe.py"), arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as ProbeOutput;
  assert.deepEqual(out.values.env, ['set:["apps/web/.env.local"]', 'set:[".env"]', 'set:["apps/gone/.env.local", "apps/web/.env.local"]']);
});

test("the tip probe reads the Mac's agent.branch and the box's sieun/dev", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-tip-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "sieun/dev");
  git("commit", "-q", "--allow-empty", "-m", "shared");
  const shared = git("rev-parse", "HEAD").slice(0, 10);
  git("checkout", "-q", "-b", "dev/mac");
  writeFileSync(join(repo, "own.txt"), "own");
  git("add", "own.txt");
  git("commit", "-q", "-m", "own");
  const own = git("rev-parse", "HEAD").slice(0, 10);
  const run = (host: "mac" | "box") => {
    const arg = Buffer.from(JSON.stringify({ host, rows: [{ id: "tip", tool: "checkout tip", probes: [{ tip: true }] }], known: {} })).toString("base64");
    const out = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../scripts/duties/box-parity-probe.py"), arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as ProbeOutput;
    return out.values.tip![0]!;
  };
  assert.deepEqual((JSON.parse(run("mac").slice(8)) as [string][]).map(([id]) => id), [shared]);
  git("config", "agent.branch", "dev/mac");
  assert.deepEqual((JSON.parse(run("mac").slice(8)) as [string, string, string[], boolean][]).map(([id, , , pushed]) => [id, pushed]), [[own, false], [shared, false]]);
  assert.deepEqual((JSON.parse(run("box").slice(8)) as { ids: string[] }).ids, [shared]);
  assert.equal(shortfall(run("mac"), run("box")), null);
  assert.match(unpushedNote(run("mac"), run("box"))!, new RegExp(`1 of its last 2 .*: ${own}$`));
  git("update-ref", "refs/remotes/origin/dev/mac", git("rev-parse", "HEAD"));
  assert.deepEqual((JSON.parse(run("mac").slice(8)) as [string, string, string[], boolean][]).map(([, , , pushed]) => pushed), [true, true]);
  assert.deepEqual((JSON.parse(run("box").slice(8)) as { fetched: string[] }).fetched, [own]);
  assert.equal(shortfall(run("mac"), run("box")), null);
  assert.equal(unpushedNote(run("mac"), run("box")), null);
});

test("the audit rows keep the box's dropped cua-driver out of tool_rows_off, and the tip row counts only the Mac commits it pushed", () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/box-parity.rows.json"), "utf8")) as Row[];
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const id of ["mcp-cua-driver", "cli-cua-driver", "tools-panel-check-cua-permissions", "tools-panel-check-cua-mcp", "tools-panel-check-cua-version"])
    assert.match(byId.get(id)?.byDesign ?? "", /60e99f7d/, id);
  const tip = byId.get("auto-sns-agent-checkout-tip")!;
  assert.equal(tip.byDesign, undefined);
  const judge = (pushed: boolean) => judgeRows([tip], output("mac", { [tip.id]: [`commits:${JSON.stringify([["aaaaaaaaaa", "p-mac", ["k-mac"], pushed]])}`] }),
    output("box", { [tip.id]: [`commits:${JSON.stringify({ ids: [], patches: [], bytes: [], fetched: [] })}`] }), new Map());
  assert.equal(judge(true).off.length, 1);
  assert.deepEqual([judge(false).off.length, judge(false).unpushed.length], [0, 1]);
});
