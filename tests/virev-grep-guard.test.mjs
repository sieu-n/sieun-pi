import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onToolCall } from "../components/virev/ext-impl/virev/git-guard.mjs";
import { parseGrep } from "../components/virev/ext-impl/virev/grep-guard.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "virev-grep-")));
const home = join(root, "home");
const project = join(home, "Documents/Github/auto-sns-agent");
const elsewhere = join(home, "Documents/Github/sieun-pi");
for (const dir of [
  join(home, ".prime/agent/skills"),
  join(project, ".git"),
  join(project, "apps/search/src/lib"),
  join(project, "apps/llm-wiki/content/sessions/2026/10/08/0900-job"),
  join(project, "scripts"),
  join(elsewhere, ".git"),
]) mkdirSync(dir, { recursive: true });
const configPath = join(root, "virev-projects.json");
writeFileSync(configPath, JSON.stringify({ projects: [{ root: project, policy: "auto-sns-agent" }] }));

const saved = { HOME: process.env.HOME, VIREV_PROJECTS_FILE: process.env.VIREV_PROJECTS_FILE };
process.env.HOME = home;
process.env.VIREV_PROJECTS_FILE = configPath;
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const call = (toolName, text, cwd = project) =>
  onToolCall({ type: "tool_call", toolCallId: "grep", toolName, input: toolName === "bash" ? { command: text } : { code: text } }, { cwd });

const refused = [
  "grep -r foo apps/llm-wiki/content",
  "grep -rn foo apps/llm-wiki/content/sessions",
  "grep -r foo apps/llm-wiki/content/sessions/2026/10",
  "grep -r foo apps/llm-wiki/content/archive",
  "grep -R foo .",
  "grep -rl foo",
  "grep --recursive foo apps",
  "grep -d recurse foo apps",
  "grep -r foo apps/*",
  "grep -r foo ~/.prime",
  "grep -r foo ~/.prime/agent",
  "grep -r foo $HOME",
  "grep -r foo ~",
  "egrep -ri 'a|b' apps/llm-wiki",
  "cd apps && grep -r foo llm-wiki",
  "rg -l foo scripts && grep -r foo .",
  "cat list.txt | grep -r foo apps",
  "bash -lc 'grep -r foo apps/llm-wiki/content'",
  'echo "$(grep -r foo apps)"',
];

for (const command of refused) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} refuses ${command}`, async () => {
      const text = toolName === "bash" ? command : `handle = bash(${JSON.stringify(command)})`;
      const result = await call(toolName, text);
      assert.equal(result?.block, true, text);
      assert.match(result.reason, /virev grep guard/);
      assert.match(result.reason, /`rg -n /);
    });
  }
}

test("a session outside every configured project is guarded too", async () => {
  for (const command of ["grep -r foo ~/.prime", "grep -r foo ../auto-sns-agent/apps"]) {
    assert.equal((await call("bash", command, elsewhere))?.block, true, command);
  }
  assert.equal((await call("bash", "grep -r foo .", home))?.block, true);
});

const allowed = [
  "grep -r foo apps/search/src/lib",
  "grep -rn foo scripts",
  "grep -r foo apps/llm-wiki/content/sessions/2026/10/08",
  "grep -r foo apps/llm-wiki/content/sessions/2026/10/08/0900-job",
  "grep -r foo ~/.prime/agent/skills",
  "grep foo apps/llm-wiki/content/index.html",
  "grep -n foo package.json",
  "cat big.log | grep foo",
  "rg -n foo apps/llm-wiki/content",
  "printf '%s' 'grep -r foo .'",
  "cat <<'EOF'\ngrep -r foo .\nEOF",
];

for (const command of allowed) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} allows ${command.split("\n")[0]}`, async () => {
      const text = toolName === "bash" ? command : `await bash(${JSON.stringify(command)})`;
      assert.equal(await call(toolName, text), undefined, text);
    });
  }
}

test("a recursive grep inside an unrelated repo stays allowed", async () => {
  assert.equal(await call("bash", "grep -r foo .", elsewhere), undefined);
});

test("the refusal prints the rg command with the pattern and carried flags", async () => {
  const content = await call("bash", "grep -rni 'auth token' apps/llm-wiki/content");
  assert.match(content.reason, /`grep -r` over `apps\/llm-wiki\/content` is refused/);
  assert.match(content.reason, /`rg -n -i 'auth token' <narrow path>`/);
  assert.match(content.reason, /`rg -n -i 'auth token' apps\/search\/src\/lib`/);
  assert.match(content.reason, /sessions\/2026\/10\/08\/<session-folder>/);
  const prime = await call("bash", "grep -rl needle ~/.prime");
  assert.match(prime.reason, /`rg -n -l needle ~\/.prime\/agent\/skills`/);
  const file = await call("bash", "grep -r -f pats.txt .");
  assert.match(file.reason, /`rg -n -f pats.txt <narrow path>`/);
});

test("parseGrep reads patterns, value flags, and the default path", () => {
  assert.deepEqual(parseGrep(["grep", "-rn", "foo"]), { recursive: true, pattern: "foo", paths: ["."], carried: [] });
  assert.deepEqual(parseGrep(["grep", "-e", "-r", "a", "b"]), { recursive: false, pattern: "-r", paths: ["a", "b"], carried: [] });
  assert.deepEqual(parseGrep(["grep", "-A3", "-r", "x", "--", "-dir"]), { recursive: true, pattern: "x", paths: ["-dir"], carried: [] });
  assert.equal(parseGrep(["grep", "--include=*.ts", "-R", "x", "src"]).recursive, true);
  assert.deepEqual(parseGrep(["fgrep", "-r", "x", "src"]).carried, ["-F"]);
});

test("the guard off switch also turns the grep rule off", async () => {
  process.env.VIREV_GIT_GUARD = "off";
  try {
    assert.equal(await call("bash", "grep -r foo ."), undefined);
  } finally {
    delete process.env.VIREV_GIT_GUARD;
  }
});
