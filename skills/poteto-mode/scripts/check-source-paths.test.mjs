import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = dirname(skillDir);
const documents = [
  "SKILL.md",
  ...["playbooks", "references"].flatMap((directory) =>
    readdirSync(resolve(skillDir, directory))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${directory}/${name}`),
  ),
].map((name) => ({ name, text: readFileSync(resolve(skillDir, name), "utf8") }));

test("skill sources do not come from the caller repo or a fixed profile", () => {
  for (const { name, text } of documents) {
    for (const [index, line] of text.split("\n").entries()) {
      const location = `${name}:${index + 1}`;
      assert.doesNotMatch(line, /(?<![\w-])pstack\//, location);
      assert.doesNotMatch(line, /(?:~|\$HOME)\/\.prime\/agent\/skills\//, location);
      assert.doesNotMatch(line, /(?:\/Users|\/home)\/[^\s`]+\/skills\//, location);
      assert.doesNotMatch(line, /git show origin\/main:.*(?:skill|playbook)/, location);
      assert.doesNotMatch(line, /`(?:node|bun|bash) (?:scripts|playbooks)\//, location);
    }
  }
});

test("documented source paths exist in the packaged layout", () => {
  const checked = new Set();
  for (const { name, text } of documents) {
    const paths = text.matchAll(/(?<![\w/$])(?:\$POTETO_MODE_DIR\/|\$POTETO_SKILLS_DIR\/|\.\.\/|(?:playbooks|references|scripts)\/)[^\s`"<>]*/g);
    for (const match of paths) {
      if (text[match.index + match[0].length] === "<") continue;
      const source = match[0];
      let target;
      if (source.startsWith("$POTETO_MODE_DIR/")) {
        target = resolve(skillDir, source.slice("$POTETO_MODE_DIR/".length));
      } else if (source.startsWith("$POTETO_SKILLS_DIR/")) {
        target = resolve(skillsDir, source.slice("$POTETO_SKILLS_DIR/".length));
      } else if (source.startsWith("../")) {
        target = resolve(dirname(resolve(skillDir, name)), source);
      } else {
        target = resolve(skillDir, source);
      }
      assert.doesNotThrow(() => statSync(target), `${name}: ${source}`);
      checked.add(target);
    }
  }
  for (const source of [
    "scripts/check-plan.mjs",
    "scripts/watch-pr/watch-pr",
    "scripts/orch/orch.ts",
    "scripts/worktree-audit.sh",
    "../setup-pstack/references/prime-agent-runtime.md",
    "../swarm/SKILL.md",
    "../how/SKILL.md",
    "../interrogate/SKILL.md",
    "../show-me-your-work/SKILL.md",
  ]) {
    assert.ok(checked.has(resolve(skillDir, source)), `uncovered source: ${source}`);
  }
});

test("plan checker requires active-source reads rather than caller trunk reads", () => {
  const template = documents.find(({ name }) => name === "playbooks/multi-phase-plan.md")
    .text.split("````markdown\n")[1].split("````")[0];
  const directory = mkdtempSync(resolve(skillDir, "scripts/.path-check-"));
  try {
    const plan = resolve(directory, "plan.md");
    const sourceProblems = (text) => {
      writeFileSync(plan, text);
      const result = spawnSync(process.execPath, [resolve(skillDir, "scripts/check-plan.mjs"), plan], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
      });
      assert.ifError(result.error);
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      assert.match(result.stdout, /1 PR sections, \d+ problems/);
      return { status: result.status, problems: result.stderr.split("\n").filter(Boolean) };
    };
    assert.deepEqual(sourceProblems(template), { status: 0, problems: [] });
    for (const source of ['$POTETO_MODE_DIR/playbooks/', '$POTETO_SKILLS_DIR/']) {
      const { status, problems } = sourceProblems(template.replaceAll(`cat "${source}`, 'cat "omitted/'));
      assert.equal(status, 1);
      assert.equal(problems.length, 1);
      assert.ok(problems[0].includes(source), problems[0]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
