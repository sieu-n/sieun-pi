// On 10-18 the chat reopen launcher ran add.ts with a relative duty path from inside ~/.local/share/sieun-pi-chat/current, and its d1 got
// precheck.cwd release-7fdadbf/..., a release folder a later release prunes, because Node resolves a relative path from the physical cwd.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";

const CHAT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const ADD = fileURLToPath(new URL("../scripts/duties/add.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const run = promisify(execFile);

const DUTY = {
  name: "Fixture release", ownerWords: "fixture", goal: "the precheck runs in the live release", onMiss: "fix it",
  metrics: [{ key: "ok", label: "Ran in release-b", op: ">=", target: 1, headline: true }], schedule: { kind: "every", minutes: 30 },
  precheck: { command: ["node", "precheck.mjs"], cwd: "..", timeoutMs: 30_000 },
};
const PRECHECK = `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { ok: readFileSync("release.txt", "utf8") === "b" ? 1 : 0 } }));`;

async function release(root: string, id: string): Promise<void> {
  await mkdir(join(root, `release-${id}`, "duties"), { recursive: true });
  await writeFile(join(root, `release-${id}`, "duties", "duty.json"), JSON.stringify(DUTY));
  await writeFile(join(root, `release-${id}`, "precheck.mjs"), PRECHECK);
  await writeFile(join(root, `release-${id}`, "release.txt"), id);
}

async function addFrom(root: string, cwd: string, file: string, dataDir: string): Promise<string> {
  const home = join(root, "home");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "run") };
  await mkdir(env.TMPDIR, { recursive: true });
  const { stdout } = await run("/bin/sh", ["-c", 'cd "$1" && exec "$0" --import "$2" "$3" "$4" "$5" --data-dir "$6"', process.execPath, cwd, TSX, ADD, CHAT, file, dataDir], { env });
  return stdout;
}

test("a duty added by a relative path from inside current keeps current in its precheck cwd and runs after that release is pruned", async () => {
  const root = await mkdtemp(join(tmpdir(), "duty-add-current-"));
  try {
    await release(root, "a");
    await symlink("release-a", join(root, "current"));
    const dataDir = join(root, "data");
    assert.match(await addFrom(root, join(root, "current"), "duties/duty.json", dataDir), /^added d1 "Fixture release"/);
    const store = new DutyStore(dataDir);
    const [duty] = await store.list(CHAT);
    assert.equal(duty!.precheck.cwd, join(root, "current"));

    await release(root, "b");
    await symlink("release-b", join(root, "current.next"));
    await rename(join(root, "current.next"), join(root, "current"));
    await rm(join(root, "release-a"), { recursive: true });

    const duties = new Duties(store, {
      isChat: async () => true, now: () => Date.now() + 31 * 60_000, tickMs: 0, node: process.execPath,
      jobs: { chat: async id => ({ id, name: "Fixture", cwd: root, board: id }), working: async () => false, retire: async () => {},
        start: async (_chat, name) => ({ id: "job-1", name }) },
    });
    await duties.tick();
    await duties.settled();
    duties.close();
    const runs = await store.runs(CHAT);
    assert.deepEqual(runs.map(entry => [entry.verdict, entry.metrics.ok?.value]), [["met", 1]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a duty added by an absolute release path keeps that release in its precheck cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "duty-add-release-"));
  try {
    await release(root, "a");
    await symlink("release-a", join(root, "current"));
    const dataDir = join(root, "data");
    await addFrom(root, join(root, "current"), join(root, "release-a", "duties", "duty.json"), dataDir);
    const [duty] = await new DutyStore(dataDir).list(CHAT);
    assert.equal(duty!.precheck.cwd, join(root, "release-a"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
