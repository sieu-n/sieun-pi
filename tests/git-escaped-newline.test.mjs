import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { escapedNewline } from "../scripts/git-hooks/escaped-newline.mjs";

// 7182031c3 on 10-25 is one of 18 commits on main from 10-19 to 10-26 whose subject swallowed the body as literal \n text.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/git-hooks");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const SUBJECT = "fix(duties): Slack green deploys refreshes an expired Vercel CLI login before it reads the token\\n\\nOn 10-25 at 18:00Z d4 read a Vercel CLI login";

function repo(t) {
  const work = mkdtempSync(path.join(tmpdir(), "sieun-pi-escaped-newline-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const run = (args) => spawnSync("git", args, { cwd: work, encoding: "utf8", env: cleanEnv });
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["config", "core.hooksPath", hooks]]) {
    assert.equal(run(args).status, 0);
  }
  writeFileSync(path.join(work, "a.txt"), "a\n");
  assert.equal(run(["add", "a.txt"]).status, 0);
  return { work, run };
}

test("a literal backslash-n before text is found in the subject or the body, and one named as text or in a code span is not", () => {
  for (const message of [SUBJECT, "fix(x): a\n\nfirst line.\\nsecond line.", "fix(x): a\\n- b", "fix(x): a.\\n\\nb"]) {
    assert.notEqual(escapedNewline(message), null, message);
  }
  for (const message of [
    "fix(deploy): printf '%s\\n' $ids, which shellcheck flags",
    "feat(grafana): the key goes in with dotenvx (newlines kept as \\n), never printed",
    "fix(x): split the lines on `\\n` and `\\nfoo`\n\nA real body\nwith real lines.",
    "fix(x): a\n\n```\nprintf \"a\\nb\"\n```\n",
    "fix(x): a\n\n# ------------------------ >8 ------------------------\n+const s = \"a\\nb\";\n",
  ]) {
    assert.equal(escapedNewline(message), null, message);
  }
});

test("the commit-msg hook refuses the 7182031c3 subject and names -m and -F", (t) => {
  const r = repo(t);
  const result = r.run(["commit", "-q", "-m", SUBJECT]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /literal \\n/);
  assert.match(result.stderr, /its own -m/);
  assert.match(result.stderr, /-F <file>/);
  assert.notEqual(r.run(["rev-parse", "--verify", "-q", "HEAD"]).status, 0);
});

test("the commit-msg hook lets the same message through as two -m flags", (t) => {
  const r = repo(t);
  const [subject, body] = SUBJECT.split("\\n\\n");
  const result = r.run(["commit", "-q", "-m", subject, "-m", body]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.run(["log", "-1", "--format=%s"]).stdout.trim(), subject);
});
