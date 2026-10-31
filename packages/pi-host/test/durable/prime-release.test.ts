/**
 * A Prime update while pi-host runs (`rlm.ts`, pi-rlm `core/python.ts`). Prime installs each release in its own folder, points
 * `~/.local/share/prime-agent/bin/prime-agent` at it and deletes the release before the previous one, so the bundled skills move:
 * 1. A kernel started after the switch imports the new release's skills, even with the old folder gone.
 * 2. A kernel started before the switch keeps running cells.
 * 3. The kernel venv's fingerprint leaves folder paths out, so a release with the same `pyproject.toml` files keeps the venv.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { kernelFingerprint, pythonSkillOf } from "../../../pi-rlm/src/core/python.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { cell, context, entriesOf, lastText, openThread, results, say } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-release-"));
const home = join(dir, "home");
process.env.HOME = home;
mkdirSync(join(dir, "threads"), { recursive: true });
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const prime = join(home, ".local/share/prime-agent");
const releaseDir = (name: string) => join(prime, "releases", name);

/** A Prime release folder with its binary and one bundled Python skill, `relskill`, whose RELEASE is the folder name. */
function installRelease(name: string, version = "0.1.0"): void {
  const skill = join(releaseDir(name), "skills", "relskill");
  mkdirSync(join(skill, "src", "relskill"), { recursive: true });
  writeFileSync(join(releaseDir(name), "prime-agent"), "#!/bin/sh\n");
  writeFileSync(join(skill, "SKILL.md"), "---\nname: relskill\ndescription: A bundled skill that names its release.\n---\n\n# Relskill\n");
  writeFileSync(join(skill, "pyproject.toml"), `[project]\nname = "relskill"\nversion = "${version}"\n`);
  writeFileSync(join(skill, "src", "relskill", "__init__.py"), `RELEASE = ${JSON.stringify(name)}\n`);
}

/** Points bin/prime-agent at a release the way an installer does, with one rename. */
function switchTo(name: string): void {
  mkdirSync(join(prime, "bin"), { recursive: true });
  const link = join(prime, "bin", "prime-agent");
  symlinkSync(join("..", "releases", name, "prime-agent"), `${link}.new`);
  renameSync(`${link}.new`, link);
}

let rlm: DurableRlm;
before(async () => {
  await testPython();
  installRelease("test.16");
  switchTo("test.16");
  rlm = await DurableRlm.load({ agentDir: join(dir, "agent"), venvRoot: join(dir, "venv"), idleMs: 60_000 });
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("a kernel started after a Prime release switch imports the new release's skills, and a kernel started before keeps working", async () => {
  const open = (id: string) => openThread(join(dir, "threads", `${id}.sqlite`), id, rlm, ({ messages }) => {
    const last = lastText(messages);
    if (last === "which") return cell("import relskill\nprint(relskill.RELEASE)");
    if (last === "again") return cell("print('still', relskill.RELEASE)");
    return say("done");
  }, dir);
  const ask = async (thread: Awaited<ReturnType<typeof open>>, content: string) => {
    await (await thread.root.submit({ type: "input", content }, context)).wait(context);
    return results(await entriesOf(thread.harness)).at(-1);
  };

  const early = await open("early");
  assert.equal((await ask(early, "which"))?.text.trim(), "test.16");

  installRelease("test.19");
  switchTo("test.19");
  rmSync(releaseDir("test.16"), { recursive: true, force: true });

  const late = await open("late");
  const answer = await ask(late, "which");
  assert.equal(answer?.isError, false, answer?.text);
  assert.equal(answer?.text.trim(), "test.19");
  assert.deepEqual(rlm.live().sort(), ["early:1", "late:1"]);

  const still = await ask(early, "again");
  assert.equal(still?.isError, false, still?.text);
  assert.equal(still?.text.trim(), "still test.16");

  for (const thread of [early, late]) await thread.harness.close(context);
  await rlm.closeThread("early", "idle");
  await rlm.closeThread("late", "idle");
});

test("the kernel venv's fingerprint changes with a skill's pyproject.toml and not with its release folder", () => {
  installRelease("same-a");
  installRelease("same-b");
  installRelease("bumped", "0.2.0");
  const skillsOf = (name: string) => [pythonSkillOf("relskill", join(releaseDir(name), "skills", "relskill"))!];
  const packages = ["dill"];
  assert.equal(kernelFingerprint(packages, skillsOf("same-a")), kernelFingerprint(packages, skillsOf("same-b")));
  assert.notEqual(kernelFingerprint(packages, skillsOf("same-a")), kernelFingerprint(packages, skillsOf("bumped")));
});
