import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PIN_FILE, pinSkillPaths, skillSourcePaths } from "../scripts/kernel-skill-paths.ts";

const run = promisify(execFile);

/** Imports toyskill with only `site` as the kernel would load it: every .pth in the site-packages folder, nothing else on the path. */
async function importToy(site: string): Promise<{ ok: boolean; out: string }> {
  const code = `import site; site.addsitedir(${JSON.stringify(site)}); import toyskill; print(toyskill.__file__)`;
  return run("python3", ["-S", "-c", code]).then(result => ({ ok: true, out: result.stdout.trim() }), (error: { stderr?: string }) => ({ ok: false, out: error.stderr ?? "" }));
}

/** A home whose ~/.prime/agent/skills links into a repo, as on the owner's Mac, and a kernel venv whose site-packages has no skill files. */
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kernel-skill-paths-")));
  const repo = join(root, "repo/skills");
  const skills = join(root, "home/.prime/agent/skills");
  const site = join(root, "home/.prime/agent/kernel-venv/lib/python3.11/site-packages");
  await mkdir(join(repo, "toy/src/toyskill"), { recursive: true });
  await writeFile(join(repo, "toy/pyproject.toml"), "[project]\nname = \"toyskill\"\nversion = \"1.0.0\"\n");
  await writeFile(join(repo, "toy/src/toyskill/__init__.py"), "X = 1\n");
  await mkdir(join(repo, "markdown-only"), { recursive: true });
  await writeFile(join(repo, "markdown-only/SKILL.md"), "---\nname: markdown-only\n---\n");
  await mkdir(join(repo, "no-src"), { recursive: true });
  await writeFile(join(repo, "no-src/pyproject.toml"), "[project]\nname = \"no-src\"\n");
  await mkdir(skills, { recursive: true });
  for (const name of ["toy", "markdown-only", "no-src"]) await symlink(join(repo, name), join(skills, name));
  await symlink(join(repo, "gone"), join(skills, "gone"));
  await mkdir(site, { recursive: true });
  return { root, repo, skills, site, home: join(root, "home"), venv: join(root, "home/.prime/agent/kernel-venv") };
}

test("kernel skill paths: a skill stays importable after uv deletes its editable .pth during a reinstall", async () => {
  const { root, repo, skills, site, home, venv } = await layout();
  try {
    const editable = join(site, "_editable_impl_toyskill.pth");
    await writeFile(editable, `${join(repo, "toy/src")}\n`);
    assert.equal((await importToy(site)).ok, true, "the editable install alone imports");
    await rm(editable);
    const before = await importToy(site);
    assert.equal(before.ok, false, "without the pin, the delete step of a reinstall leaves no module");
    assert.match(before.out, /ModuleNotFoundError: No module named 'toyskill'/);

    const [first] = await pinSkillPaths({ home, venv, skillsDir: skills });
    assert.deepEqual(first, { file: join(site, PIN_FILE), written: true, paths: [join(repo, "toy/src")] });
    assert.equal(await readFile(join(site, PIN_FILE), "utf8"), `${join(repo, "toy/src")}\n`);
    const after = await importToy(site);
    assert.equal(after.ok, true, after.out);
    assert.equal(after.out, join(repo, "toy/src/toyskill/__init__.py"));

    await writeFile(editable, `${join(repo, "toy/src")}\n`);
    await rm(editable);
    assert.equal((await importToy(site)).ok, true, "a second reinstall cut after its delete step still leaves the module importable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("kernel skill paths: a second run leaves the file alone, and an empty skills folder never removes it", async () => {
  const { root, repo, skills, site, home, venv } = await layout();
  try {
    await pinSkillPaths({ home, venv, skillsDir: skills });
    const [again] = await pinSkillPaths({ home, venv, skillsDir: skills });
    assert.equal(again!.written, false);
    const [empty] = await pinSkillPaths({ home, venv, skillsDir: join(root, "missing") });
    assert.deepEqual(empty, { file: join(site, PIN_FILE), written: false, paths: [] });
    assert.equal(await readFile(join(site, PIN_FILE), "utf8"), `${join(repo, "toy/src")}\n`);
    assert.deepEqual(await skillSourcePaths(skills), [join(repo, "toy/src")], "only skills with a pyproject.toml and a src folder, links followed");
    assert.deepEqual(await pinSkillPaths({ home, venv: join(root, "no-venv"), skillsDir: skills }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
