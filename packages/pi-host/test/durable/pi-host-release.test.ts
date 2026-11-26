/**
 * A pi-host install while a kernel runs (`rlm.ts`, `release-path.ts`). The install builds each release in pi-host/release-<sha>, points
 * pi-host/current at it with one rename and prunes old releases. A kernel keeps the PYTHONPATH it started with, so on 11-26 a child Python
 * of a kernel whose release was pruned could not import pi-rlm's runtime or skills. The kernel's PYTHONPATH now names them through current.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { cell, context, entriesOf, lastText, openThread, results, say } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-release-"));
mkdirSync(join(dir, "threads"), { recursive: true });
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
// A run from inside a pi-host kernel inherits that kernel's PYTHONPATH, which names the live install's releases.
delete process.env.PYTHONPATH;

const share = join(dir, "share", "pi-host");
const releaseDir = (name: string) => join(share, `release-${name}`);

/** A pi-host release folder with one Python skill, `relskill`, whose RELEASE is the release name. */
function installRelease(name: string): void {
  const skill = join(releaseDir(name), "skills", "relskill");
  mkdirSync(join(skill, "src", "relskill"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: relskill\ndescription: A skill that names its pi-host release.\n---\n\n# Relskill\n");
  writeFileSync(join(skill, "pyproject.toml"), `[project]\nname = "relskill"\nversion = "0.1.0"\n`);
  writeFileSync(join(skill, "src", "relskill", "__init__.py"), `RELEASE = ${JSON.stringify(name)}\n`);
}

/** Points pi-host/current at a release the way install-pi-host-box.mjs does, with one rename. */
function switchTo(name: string): void {
  symlinkSync(`release-${name}`, join(share, "current.new"));
  renameSync(join(share, "current.new"), join(share, "current"));
}

let rlm: DurableRlm;
before(async () => {
  await testPython();
  installRelease("aaaaaaa");
  switchTo("aaaaaaa");
  rlm = await DurableRlm.load({ agentDir: join(dir, "agent"), bundledSkillsDir: join(releaseDir("aaaaaaa"), "skills"), venvRoot: join(dir, "venv"), idleMs: 60_000 });
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const CHILD = [
  "import os, subprocess, sys",
  "print([p for p in os.environ['PYTHONPATH'].split(os.pathsep) if 'pi-host' + os.sep + 'release-' in p])",
  "r = subprocess.run([sys.executable, '-c', 'import relskill; print(relskill.RELEASE)'], capture_output=True, text=True)",
  "print(r.returncode, r.stdout.strip(), r.stderr.strip()[-200:])",
].join("\n");

test("a child Python of a kernel whose pi-host release was pruned still imports the release's skills, through pi-host/current", async () => {
  const thread = await openThread(join(dir, "threads", "t.sqlite"), "t", rlm, ({ messages }) => {
    const last = lastText(messages);
    if (last === "start") return cell("print('up')");
    if (last === "child") return cell(CHILD);
    return say("done");
  }, dir);
  const ask = async (content: string) => {
    await (await thread.root.submit({ type: "input", content }, context)).wait(context);
    return results(await entriesOf(thread.harness)).at(-1);
  };

  assert.equal((await ask("start"))?.text.trim(), "up");
  installRelease("bbbbbbb");
  switchTo("bbbbbbb");
  rmSync(releaseDir("aaaaaaa"), { recursive: true, force: true });

  const answer = await ask("child");
  assert.equal(answer?.isError, false, answer?.text);
  assert.deepEqual(answer?.text.trim().split("\n"), ["[]", "0 bbbbbbb"]);

  await thread.harness.close(context);
  await rlm.closeThread("t", "idle");
});
