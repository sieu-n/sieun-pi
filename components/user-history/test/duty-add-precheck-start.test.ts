// On 10-22 at 13:07Z a job ran add.ts with a copy of slack-green-deploys.duty.json two folders under ~/scratch, so its `"cwd": "../.."` became
// ~/scratch and the 13:08Z run of d4 failed with "Cannot find package 'tsx' imported from /home/sieun/scratch/".
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";

const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const HERE = fileURLToPath(new URL("..", import.meta.url));
const ADD = join(HERE, "scripts/duties/add.ts");
const TSX = import.meta.resolve("tsx");
const run = promisify(execFile);

function duty(command: string[], cwd: string): object {
  return { name: "Fixture deploys", ownerWords: "fixture", goal: "the precheck starts", onMiss: "fix it",
    metrics: [{ key: "ok", label: "Started", op: ">=", target: 1, headline: true }], schedule: { kind: "every", minutes: 30 },
    precheck: { command, cwd, timeoutMs: 30_000 } };
}

async function add(file: string, dataDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", TSX, ADD, CHAT, file, "--data-dir", dataDir]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test("a duty copied two folders under a scratch folder is refused, because its precheck finds neither its script nor tsx", async () => {
  const root = await mkdtemp(join(tmpdir(), "duty-add-start-"));
  try {
    const file = join(root, "a", "b", "deploys.duty.json");
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(file, JSON.stringify(duty(["node", "--import", "tsx", "scripts/duties/slack-green-deploys.ts"], "../..")));
    const result = await add(file, join(root, "data"));
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `refused ${file}: precheck scripts/duties/slack-green-deploys.ts, tsx not found from ${root}\n`);
    assert.deepEqual(await new DutyStore(join(root, "data")).list(CHAT), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a duty whose precheck cwd does not exist is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "duty-add-start-"));
  try {
    const file = join(root, "duty.json");
    await writeFile(file, JSON.stringify(duty(["node", "precheck.mjs"], "gone")));
    const result = await add(file, join(root, "data"));
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `refused ${file}: precheck cwd not found from ${join(root, "gone")}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a duty whose script and tsx resolve from its cwd is added", async () => {
  const root = await mkdtemp(join(tmpdir(), "duty-add-start-"));
  try {
    const file = join(root, "duty.json");
    await writeFile(file, JSON.stringify(duty(["node", "--import", "tsx", "scripts/duties/slack-green-deploys.ts"], HERE)));
    const result = await add(file, join(root, "data"));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^added d1 "Fixture deploys"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
