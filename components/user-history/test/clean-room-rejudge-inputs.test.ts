// On 10-25 rejudging carried-wait run-4's archive with AGENT_CHAT_DATA_DIR at an empty folder turned its pass into open, because rejudge
// redirected only the session files and the judge still read the live service.log and pushes file. An archive now holds every file its judge
// reads under home/, rejudge reads only those, and a supplement adds what an older archive lacks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { TASK } from "../scripts/clean-room/carried-wait.ts";
import type { ArchiveManifest, SupplementManifest } from "../scripts/clean-room/run-archive.ts";

const HERE = join(import.meta.dirname, "..");
const run$ = promisify(execFile);
const CHAT = "01a16e1d-6592-73c6-9a96-81184bf35e5a";
const JOB = "01a16e8a-0000-7000-8000-000000000002";
const WRITER = "01a16f95-b211-758c-8541-498f6cbe20c9";
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const NESTED = "01a16f97-0000-7000-8000-000000000007";
const START = Date.parse("2026-10-24T13:33:31Z");
const UNTIL = START + 4 * 3_600_000;
const iso = (offsetMin: number): string => new Date(START + offsetMin * 60_000).toISOString();
const jsonl = (lines: readonly object[]): string => lines.map(line => JSON.stringify(line)).join("\n") + "\n";
const user = (min: number, text: string) => ({ type: "message", timestamp: iso(min), message: { role: "user", content: [{ type: "text", text }] } });
const header = (id: string, min: number, parent?: string) => ({ type: "session", version: 3, id, timestamp: iso(min), ...parent ? { parentSession: parent } : {} });
const fromSession = (min: number, id: string, name: string, relation: string, text: string) => ({ type: "custom_message", timestamp: iso(min), customType: "agent_message",
  content: text, details: { from: { sessionId: id, sessionName: name }, fromRelationship: relation } });
const STEER = `chat ${CHAT.slice(0, 8)}: check-in job steered job disk sampler`;
const SERVICE_LOG = [`${iso(-93)} daemon start`, STEER, `${iso(-33)} tick before the window`, `${iso(150)} check-in tick`, STEER,
  `${iso(247)} tick past the window end`, STEER].join("\n") + "\n";

interface Fixture { root: string; data: string; record: string; run: string; env: NodeJS.ProcessEnv; prime: string }

/**
 * A carried-wait run that passes only by service.log: the chat's root job "disk sampler" got a "[check-in] " note at 16:04Z, which only the
 * steer line of this chat makes the chat's own. Its subagent reports to it, and the chat asked an outside thread something and got its answer.
 */
function fixture(serviceLog: boolean): Fixture {
  const root = mkdtempSync(join(tmpdir(), "clean-room-rejudge-inputs-"));
  const data = join(root, "data"), prime = join(root, ".prime/agent"), record = join(root, "clean-room", "carried-wait"), run = join(record, "run-1");
  for (const dir of [join(run, "boards"), join(run, "agents"), join(prime, "sessions"), join(prime, "session-artifacts", JOB, "sub-ee61925a"), data, join(root, "work/plan-audit")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(run, "criteria.md"), "a to f of the carried-wait criteria\n");
  writeFileSync(join(run, "run.json"), JSON.stringify({ scenario: "carried-wait", chat: { id: CHAT, name: "free space log" }, fixtures: {}, sandbox: root, everyMs: 1_800_000,
    release: "release-test", board: "", seeds: [TASK], setupAt: START, windowStart: START, until: UNTIL }));
  writeFileSync(join(run, "boards", "000001.json"), JSON.stringify({ v: 2, rev: 1, updatedAt: iso(1), todos: [], plan: [
    { id: "p1", text: "Show how free space on / moves", status: "doing", children: [] },
    { id: "p2", text: "Sample free space every 15 minutes", status: "doing", job: "disk sampler", sessionId: JOB, children: [] },
    { id: "p3", text: "Check the last sample and write the page", status: "todo", waitFor: "p2's 12th reading", children: [] }] }));
  writeFileSync(join(run, "agents", `${START + 60_000}.json`), JSON.stringify([{ key: `thread:${JOB}`, sessionId: JOB, name: "disk sampler", job: "disk sampler",
    sender: "disk sampler", link: "root", state: "working", steps: ["p2"] }]));
  writeFileSync(join(run, "runs.jsonl"), JSON.stringify({ duty: "checkin", at: START + 150 * 60_000, trigger: "schedule", flagged: [],
    metrics: { goal_gaps: { value: 0 }, stuck_steps: { value: 0 } } }) + "\n");
  writeFileSync(join(prime, "sessions", `${CHAT}.jsonl`), jsonl([header(CHAT, 0), user(0, TASK),
    { type: "message", timestamp: iso(1), message: { role: "assistant", content: [{ type: "text", text: "Starting the sampling job." }] } },
    { type: "message", timestamp: iso(40), message: { role: "toolResult", content: [], details: { sentAgentMessages: [{ message: "is / on this box ext4?", target: { sessionId: VP, sessionName: "VP" } }] } } },
    fromSession(50, VP, "VP", "sibling", "yes, ext4")]));
  writeFileSync(join(prime, "sessions", `${JOB}.jsonl`), jsonl([header(JOB, 2), user(2, "Sample free space on / every 15 minutes for 3 hours."),
    user(151, "[check-in] Report your reading count to the chat now."), fromSession(180, WRITER, "free-space-page-writer", "child", "The page is up.")]));
  writeFileSync(join(prime, "session-artifacts", JOB, "sub-ee61925a", `${WRITER}.jsonl`), jsonl([header(WRITER, 170, join(prime, "sessions", `${JOB}.jsonl`)), user(170, "write the page")]));
  writeFileSync(join(prime, "sessions", `${VP}.jsonl`), jsonl([header(VP, -600), user(-600, "another chat's private words")]));
  if (serviceLog) writeFileSync(join(data, "service.log"), SERVICE_LOG);
  writeFileSync(join(root, "work/plan-audit/pushes.jsonl"), JSON.stringify({ at: START + 60 * 60_000, chat: "01a10000-0000-7000-8000-000000000000", tag: "p9" }) + "\n");
  return { root, data, record, run, prime, env: { ...process.env, HOME: root, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "", SIEUN_PI_HOSTS: join(root, "no-hosts.json") } };
}

async function script(fx: Fixture, code: string): Promise<string> {
  const file = join(fx.root, `step-${Date.now()}-${Math.random().toString(16).slice(2)}.mts`);
  writeFileSync(file, code);
  return (await run$(process.execPath, ["--import", "tsx", file], { cwd: HERE, env: fx.env })).stdout;
}
async function archive(fx: Fixture): Promise<string> {
  const judge = { root: HERE, commit: "0".repeat(40), sha256: "0".repeat(64) };
  return (await script(fx, `import { archiveRun } from ${JSON.stringify(join(HERE, "scripts/clean-room/run-archive.ts"))};
import { readFileSync } from "node:fs";
const run = ${JSON.stringify(fx.run)};
process.stdout.write(archiveRun(run, JSON.parse(readFileSync(run + "/run.json", "utf8")), [${JSON.stringify(CHAT)}, ${JSON.stringify(JOB)}], ${JSON.stringify(fx.data)},
  { loaded: ${JSON.stringify(judge)}, current: ${JSON.stringify(judge)} }));`)).trim();
}
async function rejudge(fx: Fixture, file: string, supplements: readonly string[] = []): Promise<{ verdict: string; text: string; name: string }> {
  const out = (await run$(process.execPath, ["--import", "tsx", join(HERE, "scripts/clean-room/clean-room.ts"), "rejudge", "--archive", file,
    ...supplements.flatMap(supplement => ["--supplement", supplement])], { cwd: HERE, env: fx.env })).stdout.trim();
  const [verdict, path] = out.split(": ");
  return { verdict: verdict!, text: readFileSync(path!, "utf8"), name: path!.split("/").at(-1)! };
}
const body = (text: string): string => text.slice(0, text.indexOf("\nRejudged from "));
const f = (text: string): string => text.split("\n").find(line => line.startsWith("- f "))!;
const manifestOf = async (file: string): Promise<ArchiveManifest> => JSON.parse((await run$("tar", ["-xOzf", file, "./archive.json"])).stdout) as ArchiveManifest;
async function repack(file: string, out: string, change: (dir: string) => void): Promise<void> {
  const dir = `${out}.unpacked`;
  mkdirSync(dir, { recursive: true });
  await run$("tar", ["-xzf", file, "-C", dir]);
  change(dir);
  mkdirSync(dirname(out), { recursive: true });
  await run$("tar", ["-czf", out, "-C", dir, "."]);
  rmSync(dir, { recursive: true, force: true });
}

test("rejudge reads the sealed inputs only, so deleting or changing the live service.log, pushes file and session files changes nothing", async () => {
  const fx = fixture(true);
  try {
    const file = await archive(fx);
    const manifest = await manifestOf(file);
    const byPath = new Map(manifest.inputs.map(input => [input.path, input]));
    const log = byPath.get("home/.prime/agent/browser-chat/service.log");
    assert.ok(log && "sha256" in log, JSON.stringify(manifest.inputs));
    assert.equal(log.selection, "window slice");
    assert.equal(log.sourceSha256, createHash("sha256").update(SERVICE_LOG).digest("hex"));
    const end = log.ranges!.at(-1)!.end;
    assert.equal(log.prefixSha256, createHash("sha256").update(Buffer.from(SERVICE_LOG).subarray(0, end)).digest("hex"));
    const slice = (await run$("tar", ["-xOzf", file, "./home/.prime/agent/browser-chat/service.log"])).stdout;
    assert.equal(slice, [`${iso(-93)} daemon start`, `${iso(150)} check-in tick`, STEER, `${iso(247)} tick past the window end`].join("\n") + "\n");
    assert.equal(slice, log.ranges!.map(range => Buffer.from(SERVICE_LOG).subarray(range.start, range.end).toString()).join(""));
    for (const path of ["home/work/plan-audit/pushes.jsonl", "run-1/run.json", `home/.prime/agent/sessions/${JOB}.jsonl`, `home/.prime/agent/session-artifacts/${JOB}/sub-ee61925a/${WRITER}.jsonl`])
      assert.equal((byPath.get(path) as { selection?: string } | undefined)?.selection, "whole file", path);
    assert.ok(byPath.get("home/.cache/virev/ci-runs.json") && "missing" in byPath.get("home/.cache/virev/ci-runs.json")!, "a source that does not exist is listed missing");
    assert.deepEqual(manifest.sessions, [{ id: CHAT, kind: "run" }, { id: JOB, kind: "run" }, { id: WRITER, kind: "descendant" }, { id: VP, kind: "sender header" }]);
    assert.equal((await run$("tar", ["-xOzf", file, `./home/.prime/agent/sessions/${VP}.jsonl`])).stdout, JSON.stringify(header(VP, -600)) + "\n", "an outside sender keeps its header line only");

    const first = await rejudge(fx, file);
    assert.equal(first.verdict, "pass", first.text);
    assert.match(f(first.text), /^- f met/, first.text);

    rmSync(join(fx.data, "service.log"));
    writeFileSync(join(fx.data, "service.log"), `${iso(-93)} daemon start\n${iso(150)} tick\nchat 01a162bc: check-in job steered job disk sampler\n`);
    writeFileSync(join(fx.root, "work/plan-audit/pushes.jsonl"), JSON.stringify({ at: START + 60 * 60_000, chat: CHAT, tag: "p3" }) + "\n");
    rmSync(join(fx.prime, "sessions"), { recursive: true, force: true });
    rmSync(join(fx.prime, "session-artifacts"), { recursive: true, force: true });
    mkdirSync(join(fx.prime, "sessions"), { recursive: true });
    writeFileSync(join(fx.prime, "sessions", `${JOB}.jsonl`), jsonl([header(JOB, 2), user(2, "brief"), user(100, "an outside nudge")]));
    const again = await rejudge(fx, file);
    assert.equal(again.verdict, first.verdict);
    assert.equal(again.text, first.text);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("an archive whose service.log was missing rejudges to open, and a tampered input is refused", async () => {
  const fx = fixture(false);
  try {
    chmodSync(join(fx.root, "work/plan-audit/pushes.jsonl"), 0);
    const file = await archive(fx);
    const inputs = (await manifestOf(file)).inputs;
    const log = inputs.find(input => input.path === "home/.prime/agent/browser-chat/service.log");
    assert.ok(log && "missing" in log);
    const pushes = inputs.find(input => input.path === "home/work/plan-audit/pushes.jsonl");
    assert.ok(pushes && "denied" in pushes && pushes.denied === "EACCES", JSON.stringify(pushes));
    await assert.rejects(run$("tar", ["-xOzf", file, "./home/work/plan-audit/pushes.jsonl"]), "a denied input has no file in the archive");
    const open = await rejudge(fx, file);
    assert.equal(open.verdict, "open", open.text);
    assert.match(f(open.text), /service\.log does not cover the window/);
    assert.match(f(open.text), /the d9 pushes file was not read/);

    const tampered = join(fx.root, "tampered", "run-1.evidence.tar.gz");
    await repack(file, tampered, dir => writeFileSync(join(dir, `home/.prime/agent/sessions/${JOB}.jsonl`), "{}\n"));
    await assert.rejects(rejudge(fx, tampered), new RegExp(`holds home/\\.prime/agent/sessions/${JOB}\\.jsonl with sha256 \\w+, not the \\w+ it declares`));
    const extra = join(fx.root, "extra", "run-1.evidence.tar.gz");
    await repack(file, extra, dir => {
      mkdirSync(join(dir, "home/.prime/agent/browser-chat"), { recursive: true });
      writeFileSync(join(dir, "home/.prime/agent/browser-chat/service.log"), SERVICE_LOG);
    });
    await assert.rejects(rejudge(fx, extra), /declares home\/\.prime\/agent\/browser-chat\/service\.log missing but holds it/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("an archive from before 10-25 rejudges to open, and a supplement that lists its held sessions and adds its service.log and pushes turns it into the run's verdict", async () => {
  const fx = fixture(true);
  try {
    const file = await archive(fx);
    const sealed = await rejudge(fx, file);
    const old = join(fx.root, "old", "run-1.evidence.tar.gz");
    await repack(file, old, dir => {
      const manifest = JSON.parse(readFileSync(join(dir, "archive.json"), "utf8")) as ArchiveManifest;
      const { inputs: _, ...rest } = manifest;
      writeFileSync(join(dir, "archive.json"), JSON.stringify({ ...rest, sessions: manifest.sessions.filter(session => session.kind === "run").map(session => session.id) }));
      renameSync(join(dir, "home/.prime/agent"), join(dir, "prime"));
      rmSync(join(dir, "prime/browser-chat"), { recursive: true, force: true });
      rmSync(join(dir, "home"), { recursive: true, force: true });
      mkdirSync(join(dir, "prime/session-artifacts", JOB, "sub-ee61925a", "sub-5c2e"), { recursive: true });
      writeFileSync(join(dir, "prime/session-artifacts", JOB, "sub-ee61925a", "sub-5c2e", `${NESTED}.jsonl`),
        jsonl([header(NESTED, 175, join(fx.prime, "session-artifacts", JOB, "sub-ee61925a", `${WRITER}.jsonl`)), user(175, "draw the chart")]));
    });
    const before = await rejudge(fx, old);
    assert.equal(before.verdict, "open", before.text);
    assert.match(f(before.text), /service\.log does not cover the window|d9 pushes file was not read/);

    const supplement = join(fx.root, "old", "run-1.supplement-1.tar.gz");
    const runArchive = JSON.stringify(join(HERE, "scripts/clean-room/run-archive.ts"));
    await script(fx, `import { sealSupplement, serviceLogSlice } from ${runArchive};
import { readFileSync } from "node:fs";
const log = ${JSON.stringify(join(fx.data, "service.log"))}, pushes = ${JSON.stringify(join(fx.root, "work/plan-audit/pushes.jsonl"))};
const slice = serviceLogSlice(log, ${START}, ${UNTIL})!;
sealSupplement(${JSON.stringify(old)}, ${JSON.stringify(supplement)}, "the archive was sealed before rejudge read service.log and pushes from it", [
  { source: log, path: "home/.prime/agent/browser-chat/service.log", bytes: slice.bytes, selection: "window slice", ranges: slice.ranges },
  { source: pushes, path: "home/work/plan-audit/pushes.jsonl", bytes: readFileSync(pushes), selection: "whole file" }]);`);
    const sealedSupplement = JSON.parse((await run$("tar", ["-xOzf", supplement, "./supplement.json"])).stdout) as SupplementManifest;
    const sha = async (path: string): Promise<string> => createHash("sha256").update((await promisify(execFile)("tar", ["-xOzf", old, `./${path}`], { encoding: "buffer" })).stdout).digest("hex");
    const expected = [[`prime/session-artifacts/${JOB}/sub-ee61925a/${WRITER}.jsonl`, WRITER, "descendant"],
      [`prime/session-artifacts/${JOB}/sub-ee61925a/sub-5c2e/${NESTED}.jsonl`, NESTED, "descendant"],
      [`prime/sessions/${CHAT}.jsonl`, CHAT, "run"], [`prime/sessions/${JOB}.jsonl`, JOB, "run"], [`prime/sessions/${VP}.jsonl`, VP, "unlisted"]] as const;
    assert.deepEqual(new Set(sealedSupplement.archiveSessions.map(session => JSON.stringify(session))),
      new Set(await Promise.all(expected.map(async ([path, id, kind]) => JSON.stringify({ id, kind, path, sha256: await sha(path) })))));
    const forged = join(fx.root, "forged", "run-1.supplement-1.tar.gz");
    await repack(supplement, forged, dir => writeFileSync(join(dir, "supplement.json"),
      JSON.stringify({ ...sealedSupplement, archiveSessions: sealedSupplement.archiveSessions.filter(session => session.id !== NESTED) })));
    await assert.rejects(rejudge(fx, old, [forged]), /lists archiveSessions that differ from the session files/);
    const supplemented = await rejudge(fx, old, [supplement]);
    assert.equal(supplemented.verdict, sealed.verdict, supplemented.text);
    assert.equal(body(supplemented.text), body(sealed.text).replace("4 deliveries into it, its 1 jobs and their 1 subagents", "5 deliveries into it, its 1 jobs and their 2 subagents"),
      "the nested descendant the old archive holds counts as the trial's own");
    assert.match(supplemented.name, /^run-1\.rejudged-(?:[0-9a-f]{12}|unknown)-with-supplement-[0-9a-f]{8}\.pass\.md$/);
    assert.match(supplemented.text, /With supplement .*run-1\.supplement-1\.tar\.gz \(sha256 [0-9a-f]{12}\): the archive was sealed before/);
    assert.ok(readdirSync(join(fx.root, "old")).some(name => /^run-1\.rejudged-(?:[0-9a-f]{12}|unknown)\.open\.md$/.test(name)), "the plain rejudge is kept");

    await assert.rejects(rejudge(fx, file, [supplement]), /extends an archive with sha256/);
    await assert.rejects(script(fx, `import { sealSupplement } from ${runArchive};
sealSupplement(${JSON.stringify(file)}, ${JSON.stringify(join(fx.root, "dup.tar.gz"))}, "again", [{ source: ${JSON.stringify(join(fx.root, "work/plan-audit/pushes.jsonl"))},
  path: "home/work/plan-audit/pushes.jsonl", bytes: new Uint8Array(), selection: "whole file" }]);`), /is in .* or this supplement already/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a sender whose header names a session of the run as its parent is kept whole, and any other sender keeps its header line only", async () => {
  const fx = fixture(true);
  const SPAWNED = "01a16f99-0000-7000-8000-000000000005";
  try {
    const own = jsonl([header(SPAWNED, 160, join(fx.prime, "sessions", `${JOB}.jsonl`)), user(160, "sum up the readings")]);
    writeFileSync(join(fx.prime, "sessions", `${SPAWNED}.jsonl`), own);
    const job = readFileSync(join(fx.prime, "sessions", `${JOB}.jsonl`), "utf8");
    writeFileSync(join(fx.prime, "sessions", `${JOB}.jsonl`), job + jsonl([fromSession(190, SPAWNED, "reading summer", "child", "12 readings summed")]));
    const file = await archive(fx);
    const manifest = await manifestOf(file);
    assert.deepEqual(manifest.sessions.filter(session => session.id === SPAWNED || session.id === VP),
      [{ id: SPAWNED, kind: "descendant" }, { id: VP, kind: "sender header" }]);
    assert.equal((await run$("tar", ["-xOzf", file, `./home/.prime/agent/sessions/${SPAWNED}.jsonl`])).stdout, own);
    assert.equal(manifest.inputs.find(input => input.path === `home/.prime/agent/sessions/${SPAWNED}.jsonl`)?.selection, "whole file");
    assert.equal(manifest.inputs.find(input => input.path === `home/.prime/agent/sessions/${VP}.jsonl`)?.selection, "header line");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("rejudge maps every absolute path in run.json into the sealed copy, so a judge that follows one never reads a live file", async () => {
  const fx = fixture(true);
  const outside = mkdtempSync(join(tmpdir(), "clean-room-rejudge-outside-"));
  try {
    writeFileSync(join(outside, "notes.txt"), "live\n");
    mkdirSync(join(fx.data, "boards"), { recursive: true });
    writeFileSync(join(fx.data, "boards", "seed.json"), "{}");
    const state = JSON.parse(readFileSync(join(fx.run, "run.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(fx.run, "run.json"), JSON.stringify({ ...state, sandbox: outside, board: join(fx.data, "boards", "seed.json") }));
    const file = await archive(fx);
    const code = join(fx.root, "code", "components", "user-history");
    cpSync(join(HERE, "scripts/clean-room"), join(code, "scripts/clean-room"), { recursive: true });
    for (const part of ["src", "node_modules", "package.json", "tsconfig.json"]) symlinkSync(join(HERE, part), join(code, part));
    const judgeFile = join(code, "scripts/clean-room/carried-wait.ts");
    const head = /^export function judge\(run: string, state: RunState, now = Date\.now\(\)[^\n]*\{$/m;
    writeFileSync(judgeFile, readFileSync(judgeFile, "utf8").replace(head, line => line + "\n  return { verdict: \"open\", text: `# Clean-room run x: open\\n\\n" +
      "sandbox ${state.sandbox} live ${existsSync(join(state.sandbox, \"notes.txt\"))}\\nboard ${state.board} live ${existsSync(state.board)}\\n` };"));
    const out = (await run$(process.execPath, ["--import", "tsx", join(code, "scripts/clean-room/clean-room.ts"), "rejudge", "--archive", file], { cwd: code, env: fx.env })).stdout.trim();
    const text = readFileSync(out.split(": ")[1]!, "utf8");
    assert.match(text, new RegExp(`^sandbox \\S+\\.rejudge-\\d+/unsealed${outside} live false$`, "m"), text);
    assert.match(text, /^board \S+\.rejudge-\d+\/home\/\.prime\/agent\/browser-chat\/boards\/seed\.json live false$/m, text);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
