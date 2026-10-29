import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The repo copy guard (packages/sieun-rules/src/repo-copy.ts), owner rule c193. On 10-29 slack green guy's jobs ran tsc and next dev in
// per-job `git worktree` copies on the owner's Mac at about 1 GB each in red minutes. These commands are only fed to the handlers.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-copy-")));
const saved = process.env.GLOBAL_RULES_LOG;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  if (saved === undefined) delete process.env.GLOBAL_RULES_LOG;
  else process.env.GLOBAL_RULES_LOG = saved;
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });
const cell = (command) => `r = await bash(${JSON.stringify(command)})\nprint(r.output)`;

const COPIES = [
  "cd ~/Documents/Github/slack-green && git worktree add -b sg-fix ~/scratch/01a18790/sg-copy origin/main",
  "git -C ~/Documents/Github/slack-green worktree add ../sg-2 HEAD",
  "git clone ~/Documents/Github/auto-sns-agent /tmp/asa",
  "git clone --depth 1 /home/sieun/src/sieun-pi ./sp",
  "git clone file:///Users/sieunpark/Documents/Github/slack-green x",
  "git clone -- ../slack-green copy",
  "git archive HEAD | tar -x -C /tmp/tree",
  "git archive --format=tar -o /tmp/t.tar HEAD",
  "bash -lc 'git worktree add /tmp/w main'",
  "ssh sieunpark@100.66.173.18 'cd ~/Documents/Github/slack-green && git worktree add /tmp/w'",
  "timeout 60 git clone ./repo ../repo-copy",
  "echo start; (cd repo && git worktree add ../w2)",
];

const FINE = [
  "git worktree list",
  "git worktree remove ~/scratch/01a18790/sg-copy",
  "git worktree prune",
  "git clone https://github.com/sieu-n/prime-shared-state.git",
  "git clone git@github.com:sieu-n/slack-green.git /tmp/sg",
  "git clone us-metal02:src/sieun-pi sp",
  "git archive HEAD > /tmp/tree.tar",
  "git status",
  "rg -n 'git worktree add' skills",
  "git commit -m 'docs: never git worktree add' -- README.md",
  "echo 'never git clone a local checkout'",
];

for (const platform of ["darwin", "linux"]) {
  test(`on ${platform}, a worktree add, a local clone or an archive into a folder is refused in bash and in an ipython cell`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    for (const text of [...COPIES.map((t) => ["bash", t]), ...COPIES.map((t) => ["ipython", cell(t)])]) {
      const result = call(...text);
      assert.equal(result?.block, true, text.join(": "));
      assert.match(result.reason, /repo copy guard/);
      assert.match(result.reason, /c193/);
      assert.match(result.reason, /existing checkout/);
    }
    const argv = call("ipython", 'import subprocess\nsubprocess.run(["git", "worktree", "add", "/tmp/w", "main"])');
    assert.equal(argv?.block, true);
  });

  test(`on ${platform}, reading, removing and pruning worktrees and remote clones pass`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    for (const text of FINE) {
      assert.equal(call("bash", text), undefined, text);
      assert.equal(call("ipython", cell(text)), undefined, text);
    }
  });
}

test("the kernel half refuses a worktree add whose command the cell builds at run time", () => {
  const result = sendCheck.judgeCheck({ kind: "shell", text: "git worktree add /tmp/w main", cwd: root });
  assert.equal(result.block, true);
  assert.match(result.reason, /repo copy guard/);
  assert.deepEqual(sendCheck.judgeCheck({ kind: "shell", text: "git worktree list", cwd: root }), { block: false });
});
