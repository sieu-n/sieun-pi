// Owner 10-18 (goal p1): us-metal02 matches the owner's MacBook Pro for every tool; these cases pin how the Box tools parity duty judges a row, a limit and port 22.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitGaps, compareVersions, containerLimits, followSteps, foldName, judgeRows, probeBoxAfterMac, runFollow, type LimitContext, managerLimits, parseLayers, parseShow, type ProbeOutput, publicSsh, rcuBoostOff, type Row, shortfall, unitLimits, unpushedNote }
  from "../scripts/duties/box-parity.ts";
import { macAway } from "../scripts/duties/mac-reach.ts";

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

test("judgeRows takes a panel fail that the probe's shared regex matches as a match, and still counts any other fail", () => {
  const rows: Row[] = [{ id: "search", tool: "tools-panel check websearch_query", mac: [{ const: "ok" }], box: [{ panel: "websearch_query", shared: "Google is down on the Virev" }] }];
  const mac = output("mac", { search: ["ok"] });
  const box = output("box", { search: ["panel"] });
  const fail = (detail: string) => new Map([["websearch_query", { status: "fail" as const, fixer: "agent" as const, detail, fix: "x" }]]);
  assert.equal(judgeRows(rows, mac, box, fail("Google is down on the Virev search backend; results came from the DuckDuckGo fallback")).off.length, 0);
  assert.deepEqual(judgeRows(rows, mac, box, fail("Virev search error (500)")).off.map(verdict => verdict.row.id), ["search"]);
});

test("the pi-pool panel rows take an account that needs a new sign-in as shared, since the Mac reads the box's pool, and still count a pi-pool that fails on the box", () => {
  const rows = (JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/box-parity.rows.json"), "utf8")) as Row[])
    .filter(row => row.id === "tools-panel-check-pool-codex" || row.id === "tools-panel-check-websearch-query");
  const mac = output("mac", { "tools-panel-check-pool-codex": ["ok"], "tools-panel-check-websearch-query": ["ok"] });
  const box = output("box", { "tools-panel-check-pool-codex": ["panel"], "tools-panel-check-websearch-query": ["panel"] });
  const fail = (codex: string, search = "Google is down on the Virev search backend; results came from the DuckDuckGo fallback") => new Map([
    ["pool_codex", { status: "fail" as const, fixer: "agent" as const, detail: codex, fix: "x" }],
    ["websearch_query", { status: "fail" as const, fixer: "agent" as const, detail: search, fix: "x" }]]);
  const off = (codex: string, search?: string) => judgeRows(rows, mac, box, fail(codex, search)).off.map(verdict => verdict.row.id).sort();
  assert.deepEqual(off("fhnyq29tw5@privaterelay.appleid.com need a new sign-in (2 of 3 usable, 0 off)"), []);
  assert.deepEqual(off("no openai-codex account is usable and none resets within 24 h (0 of 3 usable, 0 off)"), []);
  assert.deepEqual(off("pi-pool ls exited 127: command not found"), ["tools-panel-check-pool-codex"]);
  assert.deepEqual(off("pi-pool ls exited 127: command not found", "Virev search error (500); Google is down on the Virev search backend"), ["tools-panel-check-pool-codex", "tools-panel-check-websearch-query"]);
});

const deploy = join(import.meta.dirname, "../../../../deploy/linux");
const layers = parseLayers(readFileSync(join(deploy, "cpu/setup-cpu.sh"), "utf8"), readFileSync(join(deploy, "cpu/cpu-protect.py"), "utf8"),
  readFileSync(join(deploy, "memory/heavy"), "utf8"), 1001, readFileSync(join(deploy, "cpu/rcu-boost.service"), "utf8"), readFileSync(join(deploy, "cpu/rcu-boost.py"), "utf8"));
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
  assert.equal(layers.weights.get("system user@1001.service"), "10000");
  assert.equal(layers.weights.get("user sieun-pi-chat.service"), "10000");
  assert.deepEqual([layers.nice, layers.heavy], [{ unit: "prime-agent-daemon.service", value: -10 }, { swapMax: "0", score: 500 }]);
  const asked = (unit: Record<string, string>, ...rest: Parameters<typeof context>) => unitLimits(unit, context(...rest)).map(finding => [finding.key, Boolean(finding.ownerAsked)]);
  const dropin = "/etc/systemd/system/ssh.service.d/cpu-weight.conf";
  assert.deepEqual(asked({ Id: "ssh.service", DropInPaths: dropin, CPUWeight: "1000" }, { [dropin]: "CPUWeight=1000\n" }, {}, "system"), [["system ssh.service CPUWeight", true]]);
  assert.deepEqual(asked({ Id: "ssh.service", DropInPaths: dropin, CPUWeight: "500" }, { [dropin]: "CPUWeight=500\n" }, {}, "system"), [["system ssh.service CPUWeight", false]]);
  assert.deepEqual(asked({ Id: "ssh.service", CPUWeight: "1000" }, {}, {}, "user"), [["user ssh.service CPUWeight", false]]);
  assert.deepEqual(asked({ Id: "user@1001.service", CPUWeight: "10000" }, {}, {}, "system"), [["system user@N.service CPUWeight", true]]);
  assert.deepEqual(asked({ Id: "dev.slice", CPUWeight: "300" }, {}, {}, "system"), [["system dev.slice CPUWeight", false]]);
  const daemon = { Id: "prime-agent-daemon.service", ActiveState: "active", MainPID: "7", Nice: "0", CPUWeight: "10000" };
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

test("rcu-boost.service's FIFO is owner-asked CPU layer 3, and rcu_boost_off flags a stopped watcher or another stall timeout (us-metal02 RCU stall 10-20)", () => {
  assert.deepEqual(layers.rcuBoost, { unit: "rcu-boost.service", policy: "1", stallTimeoutS: 21 });
  const watcher = { Id: "rcu-boost.service", FragmentPath: "/etc/systemd/system/rcu-boost.service", CPUSchedulingPolicy: "1" };
  const files = { [watcher.FragmentPath]: "CPUSchedulingPolicy=fifo\n" };
  assert.match(unitLimits(watcher, context(files, {}, "system"))[0]!.ownerAsked!, /CPU layer 3/);
  assert.equal(unitLimits({ ...watcher, Id: "other.service" }, context(files, {}, "system"))[0]!.ownerAsked, undefined);
  assert.equal(unitLimits({ ...watcher, CPUSchedulingPolicy: "2" }, context(files, {}, "system"))[0]!.ownerAsked, undefined);
  const running = { ActiveState: "active", SubState: "running" };
  assert.equal(rcuBoostOff(running, "21\n", 21).value, 0);
  assert.equal(rcuBoostOff(running, "60\n", 21).value, 1);
  assert.equal(rcuBoostOff({ ActiveState: "failed", SubState: "failed" }, "21\n", 21).value, 1);
  assert.equal(rcuBoostOff(running, new Error("EACCES"), 21).value, undefined);
});

test("parseLayers refuses a layer script whose shape it does not know", () => {
  assert.throws(() => parseLayers("declare -A OTHER=([a]=1)\n", "", "", 1001, "", ""), /no SYSTEM_WEIGHTS table/);
  const cpu = "declare -A SYSTEM_WEIGHTS=([a]=1)\ndeclare -A USER_WEIGHTS=([b]=2)\n";
  assert.throws(() => parseLayers(cpu, "DAEMON = \"x\"\n", "", 1001, "", ""), /no DAEMON or CORE_NICE/);
  assert.throws(() => parseLayers(cpu, "DAEMON = \"x\"\nCORE_NICE = -10\n", "exec systemd-run --user --scope -- \"$@\"\n", 1001, "", ""), /heavy has no systemd-run/);
  const heavy = readFileSync(join(deploy, "memory/heavy"), "utf8");
  assert.throws(() => parseLayers(cpu, "DAEMON = \"x\"\nCORE_NICE = -10\n", heavy, 1001, "[Service]\n", "STALL_TIMEOUT_S = 21\n"), /rcu-boost.service has no CPUSchedulingPolicy/);
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
  git("init", "-q", "-b", "dev/sieun");
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

test("the tip probe reads the Mac's agent.branch, else its current branch, and the box's dev/sieun", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-tip-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "dev/sieun");
  execFileSync("git", ["init", "-q", "--bare", join(home, "origin.git")]);
  git("remote", "add", "origin", join(home, "origin.git"));
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
  assert.deepEqual((JSON.parse(run("mac").slice(8)) as [string][]).map(([id]) => id), [own, shared]);
  git("config", "agent.branch", "dev/sieun");
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

test("the AGENTS.md row matches when the Mac's file is one the box checkout held at an ancestor of its HEAD, and stays off for content the box never had", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-blob-"));
  const repo = join(home, "src/sieun-pi");
  mkdirSync(join(repo, "config"), { recursive: true });
  mkdirSync(join(home, ".prime/agent"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const commit = (text: string) => { writeFileSync(join(repo, "config/AGENTS.md"), text); git("add", "config/AGENTS.md"); git("commit", "-q", "-m", text); };
  git("init", "-q", "-b", "main");
  commit("rules v1\n");
  commit("rules v2\n");
  git("checkout", "-q", "-b", "side");
  commit("rules on a side branch\n");
  git("checkout", "-q", "main");
  commit("rules v3\n");
  symlinkSync(join(repo, "config/AGENTS.md"), join(home, ".prime/agent/AGENTS.md"));
  const rows: Row[] = [{ id: "agents", tool: "~/.prime/agent/AGENTS.md", probes: [{ blob: "~/.prime/agent/AGENTS.md" }] }];
  const run = (host: "mac" | "box") => {
    const arg = Buffer.from(JSON.stringify({ host, rows, known: {} })).toString("base64");
    return (JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../scripts/duties/box-parity-probe.py"), arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as ProbeOutput).values.agents![0]!;
  };
  const box = run("box");
  const macWith = (text: string) => {
    writeFileSync(join(home, "mac-AGENTS.md"), text);
    return `blobs:${JSON.stringify([git("hash-object", join(home, "mac-AGENTS.md"))])}`;
  };
  assert.equal((JSON.parse(run("mac").slice(6)) as string[]).length, 1);
  assert.equal(run("mac"), macWith("rules v3\n"));
  assert.equal(shortfall(macWith("rules v3\n"), box), null);
  assert.equal(shortfall(macWith("rules v1\n"), box), null);
  assert.match(shortfall(macWith("rules on a side branch\n"), box)!, /is at no commit the box checkout's HEAD descends from/);
  assert.match(shortfall(macWith("rules only the Mac has\n"), box)!, /is at no commit the box checkout's HEAD descends from/);
  assert.equal(judgeRows(rows, output("mac", { agents: [macWith("rules v2\n")] }), output("box", { agents: [box] }), new Map()).off.length, 0);
});

// From 10-23 21:55Z to 10-26 d1 read met while tool_rows_off had no value since 10-22 21:55Z: the Mac slept through each 06:55 KST slot and the
// run spent its 90 s ssh on it. The precheck now reads Tailscale first, and an offline Mac gives a host_away item instead of an ssh, so the runner
// reruns the duty once the Mac is back.
test("d1 reads the Mac's Tailscale state from its ssh address and flags an offline Mac as host_away", async () => {
  const bin = mkdtempSync(join(tmpdir(), "box-parity-mac-away-"));
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  script("ssh", '[ "$1" = "-G" ] && echo "hostname 100.66.173.18" && exit 0; echo "no ssh to the Mac in this test" >&2; exit 255');
  const status = (online: boolean) => JSON.stringify({ Peer: { a: { TailscaleIPs: ["100.66.173.18"], Online: online, LastSeen: "2026-10-26T15:20:00.1Z" } } });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    script("tailscale", `echo '${status(false)}'`);
    const item = await macAway("mac", "tool rows are", 1);
    assert.equal(item?.kind, "host_away");
    assert.equal(item?.host, "mac");
    assert.match(item!.excerpt, /^the Mac \(100\.66\.173\.18\) is offline on the tailnet since 2026-10-26T15:20:00\.1Z, asleep or shut, so tool rows are not measured/);
    script("tailscale", `[ "$1" = ping ] && echo "pong from mac (100.66.173.18) via DERP(tok) in 301ms" && echo "direct connection not established" && exit 1; echo '${status(true)}'`);
    assert.equal(await macAway("mac", "tool rows are", 1), undefined, "an online Mac that answers a ping, even through DERP with exit 1, is read over ssh as before");
    script("tailscale", "exit 1");
    assert.equal(await macAway("mac", "tool rows are", 1), undefined, "a Tailscale read that fails leaves the ssh read to say what is wrong");
  } finally { process.env.PATH = path; }
});

// 10-26 22:18:31Z: the Mac dark-woke, Tailscale read it online for about a minute, and the host-back reruns of frontend bro's d1 and d5 timed
// out on ssh to it, read "the precheck failed" and started duty jobs that could do nothing. An online Mac with no pong now reads host_away.
test("a Mac Tailscale lists online that gives no pong to a tailscale ping is host_away, so no ssh dials a dark-woken Mac", async () => {
  const bin = mkdtempSync(join(tmpdir(), "box-parity-mac-dark-wake-"));
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  script("ssh", '[ "$1" = "-G" ] && echo "hostname 100.66.173.18" && exit 0; exit 255');
  const online = JSON.stringify({ Peer: { a: { TailscaleIPs: ["100.66.173.18"], Online: true, LastSeen: "2026-10-26T22:20:00.1Z" } } });
  script("tailscale", `[ "$1" = ping ] && echo 'ping "100.66.173.18" timed out' && echo "no reply" && exit 1; echo '${online}'`);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const item = await macAway("mac", "tool rows are", 1);
    assert.equal(item?.kind, "host_away");
    assert.equal(item?.host, "mac");
    assert.match(item!.excerpt, /^the Mac \(100\.66\.173\.18\) is listed online on the tailnet but gave no pong to a tailscale ping, a dark wake from sleep, so tool rows are not measured/);
  } finally { process.env.PATH = path; }
});

test("followSteps installs the Mac's version for a version row behind it, and the Mac's missing entries for a set", () => {
  const rows: Row[] = [
    { id: "bun", tool: "cli bun", probes: [{ version: ["bun", "--version"], follow: "bun_install" }] },
    { id: "venv", tool: "kernel venv packages", probes: [{ distinfo: "~/venv", follow: "venv" }] },
    { id: "jq", tool: "cli jq", probes: [{ version: ["jq", "--version"], follow: "jq_install" }] },
    { id: "pdf", tool: "cli pdftotext", probes: [{ version: ["pdftotext", "-v"], follow: "pdf_install", intended: "no Linux build" }] },
    { id: "docker", tool: "cli docker", probes: [{ version: ["docker", "--version"] }] },
    { id: "claude", tool: "cli claude", mac: [{ version: ["claude", "--version"] }], box: [{ version: ["claude", "--version"], follow: "npm_global claude" }] },
    { id: "odd", tool: "cli odd", probes: [{ version: ["odd"], follow: "odd_install" }] },
  ];
  const mac = output("mac", { bun: ["v:1.4.4"], venv: ['set:["a==1","python-dateutil==3.0.0","six==1.17.0"]'], jq: ["v:1.7.1"], pdf: ["v:26.10.0"],
    docker: ["v:30.0.0"], claude: ["v:2.1.400"], odd: ["=1.0;rm"] });
  const box = output("box", { bun: ["v:1.3.11"], venv: ['set:["a==1","python-dateutil==2.9.0.post0","six==1.17.0","extra==1"]'], jq: ["v:1.8.1"], pdf: ["v:26.07.0"],
    docker: ["v:29.7.2"], claude: ["absent"], odd: ["absent"] });
  assert.deepEqual(followSteps(rows, mac, box).map(step => [step.row.id, step.version, step.recipe]), [
    ["bun", "1.4.4", "bun_install"],
    ["venv", "python-dateutil==3.0.0", "venv"],
    ["claude", "2.1.400", "npm_global claude"],
  ]);
});

test("runFollow runs each step through box-follow.sh in turn and keeps a failed install's error", async () => {
  const calls: string[][] = [];
  const row: Row = { id: "bun", tool: "cli bun" };
  const done = await runFollow([{ row, version: "1.4.4", recipe: "ok" }, { row, version: "2.0.0", recipe: "fails" }], async (file, args) => {
    calls.push([file, ...args.slice(1)]);
    if (args[2] === "fails") throw new Error("bash box-follow.sh 2.0.0: curl: (22) 404");
    return "";
  });
  assert.deepEqual(calls, [["bash", "1.4.4", "ok"], ["bash", "2.0.0", "fails"]]);
  assert.equal(done[0]!.error, undefined);
  assert.match(done[1]!.error!, /404/);
});

test("box-follow.sh release unpacks a version into its own ~/.local/opt folder, lifts the top folder and links the bin", () => {
  const home = mkdtempSync(join(tmpdir(), "box-follow-"));
  const source = join(home, "src", "tool-1.2.3", "bin");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "tool"), "#!/bin/sh\necho tool 1.2.3\n", { mode: 0o755 });
  execFileSync("tar", ["-czf", join(home, "tool.tar.gz"), "-C", join(home, "src"), "tool-1.2.3"]);
  const script = join(import.meta.dirname, "../scripts/duties/box-follow.sh");
  execFileSync("bash", [script, "1.2.3", `release tool "file://${home}/tool.tar.gz" bin/tool`], { env: { ...process.env, HOME: home } });
  assert.equal(execFileSync(join(home, ".local/bin/tool"), { encoding: "utf8" }), "tool 1.2.3\n");
  assert.equal(execFileSync("readlink", [join(home, ".local/bin/tool")], { encoding: "utf8" }).trim(), join(home, ".local/opt/tool-1.2.3/bin/tool"));
});

test("box-follow.sh playwright_browsers installs each browser folder with the newest stable Playwright whose browsers.json gives its revision", () => {
  const home = mkdtempSync(join(tmpdir(), "box-follow-"));
  const bin = join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const browsers: Record<string, [string, string][]> = {
    "1.63.0": [["chromium-headless-shell", "1243"], ["ffmpeg", "1011"]],
    "1.64.0": [["chromium-headless-shell", "1248"], ["ffmpeg", "1013"]],
    "1.64.1": [["chromium-headless-shell", "1249"], ["ffmpeg", "1013"]],
  };
  for (const [version, list] of Object.entries(browsers)) {
    writeFileSync(join(home, `${version}.json`), JSON.stringify({ browsers: list.map(([name, revision]) => ({ name, revision })) }));
  }
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho '["1.63.0","1.64.0","1.64.1","1.65.0-alpha-1"]'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor a; do u=$a; done\nv=\${u#*/playwright/v}\ncat "${home}/\${v%%/*}.json"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$*" >> "${home}/npx.log"\n`, { mode: 0o755 });
  const script = join(import.meta.dirname, "../scripts/duties/box-follow.sh");
  const env = { ...process.env, HOME: home };
  execFileSync("bash", [script, "chromium_headless_shell-1248 ffmpeg-1013 ffmpeg-1011", "playwright_browsers"], { env });
  assert.deepEqual(readFileSync(join(home, "npx.log"), "utf8").trim().split("\n"), [
    "-y playwright@1.64.0 install chromium-headless-shell",
    "-y playwright@1.64.1 install ffmpeg",
    "-y playwright@1.63.0 install ffmpeg",
  ]);
  assert.throws(() => execFileSync("bash", [script, "webkit-2251", "playwright_browsers"], { env, stdio: "pipe" }),
    /no stable Playwright release's browsers.json on GitHub gives webkit revision 2251/);
});

test("the Playwright browsers row follows the Mac's folders the box lacks and never the lock folder", () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/box-parity.rows.json"), "utf8")) as Row[];
  const row = rows.find(candidate => candidate.id === "playwright-browsers")!;
  const mac = output("mac", { "playwright-browsers": ['set:["chromium-1243","chromium_headless_shell-1248","ffmpeg-1013"]'] });
  const box = output("box", { "playwright-browsers": ['set:["chromium-1243","chromium_headless_shell-1243"]'] });
  assert.deepEqual(followSteps([row], mac, box).map(step => [step.version, step.recipe]), [["chromium_headless_shell-1248 ffmpeg-1013", "playwright_browsers"]]);
  assert.ok(!new RegExp(String(row.box![0]!.pattern)).test("__dirlock"));
});

test("every follow recipe in box-parity.rows.json is valid bash that reads the Mac's version as $V or through a helper", () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/box-parity.rows.json"), "utf8")) as Row[];
  const recipes = rows.flatMap(row => [...row.box ?? row.probes ?? []]).map(probe => probe.follow).filter((recipe): recipe is string => typeof recipe === "string");
  assert.ok(recipes.length >= 40, `${recipes.length} recipes`);
  for (const recipe of recipes) {
    execFileSync("bash", ["-n", "-c", recipe]);
    assert.match(recipe, /\$V|\{V\}|^(venv|nvm_default|playwright_browsers|npm_global \S+|conda .+|media .+)$/, recipe);
  }
});

test("the box reads the checkout tip row only after the Mac read settles, so a commit the Mac just pushed is on origin when the box fetches", async () => {
  const rows: Row[] = [{ id: "node", tool: "node", probes: [{ version: "node" }] }, { id: "tip", tool: "checkout tip", probes: [{ tip: true }] }];
  const events: string[] = [];
  let finishMac!: () => void;
  const mac = new Promise<void>(resolve => { finishMac = resolve; });
  const probe = async (part: readonly Row[]) => {
    events.push(`box ${part.map(row => row.id).join(",")}`);
    return output("box", Object.fromEntries(part.map(row => [row.id, [`read ${row.id}`]])));
  };
  const box = probeBoxAfterMac(rows, mac, probe);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["box node"], "every other row reads alongside the Mac");
  events.push("mac done");
  finishMac();
  const read = await box;
  assert.deepEqual(events, ["box node", "mac done", "box tip"]);
  assert.deepEqual(read.values, { node: ["read node"], tip: ["read tip"] });
  assert.equal(read.ms, 2);

  const failed = await probeBoxAfterMac(rows, Promise.reject(new Error("ssh")), probe);
  assert.deepEqual(failed.values.tip, ["read tip"], "a failed Mac read still lets the tip row read");
  assert.match(shortfall('commits:[["aaaaaaaaaa","",[],true]]', "fail: git fetch: could not read from remote")!, /box fail: git fetch/);
});
