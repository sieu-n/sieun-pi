import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-grep-")));
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

const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const { onToolCall } = await import("../components/global-rules/guard.ts");
const { parseGrep } = await import("../components/global-rules/grep-guard.ts");
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
  "grep -r foo ~/.prime",
  "grep -r foo ~/.prime/agent",
  "grep -rn foo ~/.prime/agent/",
  "grep -R foo $HOME",
  "grep -r foo ${HOME}/.prime",
  "grep -r foo ~",
  "grep --recursive foo ~/.prime",
  "grep -d recurse foo ~/.prime",
  "egrep -ri 'a|b' ~/.prime/agent",
  "cd ~ && grep -r foo .prime",
  "cd ~/.prime && grep -rl foo",
  "rg -l foo scripts && grep -r foo ~/.prime",
  "cat list.txt | grep -r foo ~/.prime",
  "bash -lc 'grep -r foo ~/.prime/agent'",
  'echo "$(grep -r foo ~/.prime)"',
];

for (const command of refused) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} refuses ${command}`, async () => {
      const text = toolName === "bash" ? command : `handle = bash(${JSON.stringify(command)})`;
      const result = await call(toolName, text);
      assert.equal(result?.block, true, text);
      assert.match(result.reason, /global-rules grep guard/);
      assert.match(result.reason, /`rg -n /);
    });
  }
}

test("the rule holds from every session cwd", async () => {
  for (const cwd of [project, elsewhere, root]) {
    assert.equal((await call("bash", "grep -r foo ~/.prime", cwd))?.block, true, cwd);
  }
  assert.equal((await call("bash", "grep -r foo .", home))?.block, true);
  assert.equal((await call("bash", "grep -r foo agent", join(home, ".prime")))?.block, true);
});

const allowed = [
  "grep -r foo apps/llm-wiki/content",
  "grep -R foo .",
  "grep -r foo apps/search/src/lib",
  "grep -rn foo scripts",
  "grep -r foo apps/llm-wiki/content/sessions/2026/10/08",
  "grep -r foo apps/llm-wiki/content/sessions/2026/10/08/0900-job",
  "grep -r foo ~/.prime/agent/skills",
  "grep foo apps/llm-wiki/content/index.html",
  "grep -n foo ~/.prime/agent/settings.json",
  "grep -n foo package.json",
  "cat big.log | grep foo",
  "rg -n foo apps/llm-wiki/content",
  "printf '%s' 'grep -r foo ~/.prime'",
  "cat <<'EOF'\ngrep -r foo ~/.prime\nEOF",
];

for (const command of allowed) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} allows ${command.split("\n")[0]}`, async () => {
      const text = toolName === "bash" ? command : `await bash(${JSON.stringify(command)})`;
      assert.equal(await call(toolName, text), undefined, text);
    });
  }
}

test("a repo's own heavy trees are left to that repo's guard", async () => {
  assert.equal(await call("bash", "grep -r foo apps/llm-wiki/content/sessions"), undefined);
  assert.equal(await call("bash", "grep -r foo .", elsewhere), undefined);
});

test("the refusal prints the rg command with the pattern and carried flags", async () => {
  const content = await call("bash", "grep -rni 'auth token' ~/.prime/agent");
  assert.match(content.reason, /`grep -r` over `~\/.prime\/agent` is refused/);
  assert.match(content.reason, /`rg -n -i 'auth token' <narrow path>`/);
  assert.match(content.reason, /`rg -n -i 'auth token' ~\/.prime\/agent\/skills`/);
  const prime = await call("bash", "grep -rl needle ~/.prime");
  assert.match(prime.reason, /`rg -n -l needle ~\/.prime\/agent\/skills`/);
  const file = await call("bash", "grep -r -f pats.txt ~");
  assert.match(file.reason, /`rg -n -f pats.txt <narrow path>`/);
});

test("parseGrep reads patterns, value flags, and the default path", () => {
  assert.deepEqual(parseGrep(["grep", "-rn", "foo"]), { recursive: true, pattern: "foo", paths: ["."], carried: [] });
  assert.deepEqual(parseGrep(["grep", "-e", "-r", "a", "b"]), { recursive: false, pattern: "-r", paths: ["a", "b"], carried: [] });
  assert.deepEqual(parseGrep(["grep", "-A3", "-r", "x", "--", "-dir"]), { recursive: true, pattern: "x", paths: ["-dir"], carried: [] });
  assert.equal(parseGrep(["grep", "--include=*.ts", "-R", "x", "src"]).recursive, true);
  assert.deepEqual(parseGrep(["fgrep", "-r", "x", "src"]).carried, ["-F"]);
});

for (const key of ["GLOBAL_RULES_GUARD", "GLOBAL_RULES"]) {
  test(`${key}=off turns the grep rule off`, async () => {
    process.env[key] = "off";
    try {
      assert.equal(await call("bash", "grep -r foo ~/.prime"), undefined);
    } finally {
      delete process.env[key];
    }
  });
}

test("a block writes the rule and the session cwd to the log", async () => {
  await call("bash", "grep -r needle-for-log ~/.prime", elsewhere);
  const lines = readFileSync(process.env.GLOBAL_RULES_LOG, "utf8").split("\n");
  assert.ok(lines.some((line) => line.includes(`[guard] block rule=grep cwd=${elsewhere} :: grep -r needle-for-log`)));
});
