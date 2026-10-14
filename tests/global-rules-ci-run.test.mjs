import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The CI run guard (auto-sns-agent repo/git-workflow SKILL.md step 7): only the release owner and Fable, and their own subagents, cancel,
// rerun or delete a GitHub Actions run of sieu-n/auto-sns-agent; other repos pass. Nothing here runs gh or curl; the handlers only read the
// command text, and the scratch checkouts have remote URLs that are never contacted.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-ci-run-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR, RLM_SESSION_DIR: process.env.RLM_SESSION_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = join(root, "chat");
delete process.env.RLM_SESSION_DIR;
const guard = await import("../components/global-rules/guard.ts");
const { judgeCheck } = await import("../components/global-rules/send-check.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const checkout = (dir, origin) => {
  const path = join(root, dir);
  mkdirSync(path);
  execFileSync("git", ["-C", path, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin], { stdio: "ignore" });
  return path;
};
const AUTO = checkout("auto-sns-agent", "https://github.com/sieu-n/auto-sns-agent.git");
const SLACK_GREEN = checkout("slack-green", "git@github.com:sieu-n/slack-green.git");

const agent = "/Users/sieunpark/.prime/agent";
const RELEASE_OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const FABLE = "01a0cc5e-0ca4-762a-90e6-566c310bd50a";
const sessions = {
  "check-in 01a13b00": `${agent}/sessions/01a13b00-9ebb-73f9-80cc-138349f4bc7d.jsonl`,
  "launch main bro child": `${agent}/session-artifacts/01a11bd7-072f-7591-ad1d-f123c276cde5/sub-03aa041c/01a13918-bc49-751b-b701-c33d1e99f838.jsonl`,
};
const keepers = {
  "release owner": `${agent}/sessions/${RELEASE_OWNER}.jsonl`,
  "release owner's subagent": `${agent}/session-artifacts/${RELEASE_OWNER}/sub-1a2b3c4d/01a13c00-0000-7000-8000-000000000001.jsonl`,
  Fable: `${agent}/sessions/${FABLE}.jsonl`,
  "Fable's grandchild": `${agent}/session-artifacts/${FABLE}/sub-5e6f7a8b/sub-9c0d1e2f/01a13c00-0000-7000-8000-000000000002.jsonl`,
};

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text, sessionFile, cwd = AUTO) =>
  guard.onToolCall(event(toolName, text), { cwd, ...(sessionFile ? { sessionManager: { getSessionFile: () => sessionFile } } : {}) });

const REFUSED_BASH = [
  "gh run cancel 38578797513",
  "gh run cancel 38578797513 --repo sieu-n/auto-sns-agent",
  "gh -R sieu-n/auto-sns-agent run cancel 38578797513",
  "gh run cancel --force 38578797513",
  "gh run rerun 38492712967",
  "gh run rerun 38492712967 --failed",
  "gh run rerun --job 115903517439",
  "gh run delete 38578797513",
  "gh api -X POST repos/sieu-n/auto-sns-agent/actions/runs/38578797513/cancel",
  "gh api --method POST /repos/sieu-n/auto-sns-agent/actions/runs/38578797513/force-cancel",
  "gh api -XPOST repos/sieu-n/auto-sns-agent/actions/runs/38492712967/rerun",
  "gh api repos/sieu-n/auto-sns-agent/actions/runs/38492712967/rerun-failed-jobs -f enable_debug_logging=false",
  "gh api --method=POST repos/sieu-n/auto-sns-agent/actions/jobs/115903517439/rerun",
  "gh api -X DELETE repos/sieu-n/auto-sns-agent/actions/runs/38578797513",
  "curl -s -X POST -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513/cancel",
  "curl -XPOST https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513/force-cancel",
  "curl --request POST https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38492712967/rerun-failed-jobs",
  "curl -d '{}' https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38492712967/rerun",
  "curl -X DELETE https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513",
  "bash -lc 'gh run cancel 38578797513'",
  "echo $(gh run cancel 38578797513)",
  "timeout 30 gh run cancel 38578797513",
  "echo 38578797513 | xargs -n1 gh run cancel",
  "for r in 1 2; do gh run cancel $r; done",
  "cd ~/Documents/Github/auto-sns-agent && gh run cancel 38578797513 2>&1 | tail -1",
  "bash <<'EOF'\ngh run cancel 38578797513\nEOF",
  "perl -e 'alarm 60; exec @ARGV' gh run cancel 38587787751 2>&1",
  "perl -e 'alarm shift; exec @ARGV' 60 /opt/homebrew/bin/gh run rerun 38282098290 2>&1; echo rc=$?",
];
const REFUSED_CELL = [
  "r=await bash('gh run cancel 38578797513'); print(r.output)",
  "for old in ['38378415979']:\n    r=await bash(f\"gh run cancel {old} 2>&1\")",
  "import subprocess\nsubprocess.run(['gh', 'run', 'rerun', '38492712967', '--failed'])",
  "!gh run delete 38578797513",
  "r = await asyncio.wait_for(run(f\"{T60} gh run cancel 38531161721 2>&1|tail -1\", 70), 90)",
];
const ALLOWED = [
  "gh run view 38578797513 --json status,conclusion",
  "gh run watch 38578797513 --interval 180 > /dev/null 2>&1",
  "gh run list --workflow verify-dev.yml --branch ci/posts-logged-in-r5 --limit 1",
  "gh run view 38578797513 --log-failed",
  "gh run download 38578797513 -n report",
  "gh run cancel --help",
  "gh api repos/sieu-n/auto-sns-agent/actions/runs/38578797513",
  "gh api repos/sieu-n/auto-sns-agent/actions/runs/38578797513/jobs -q '.jobs[].name'",
  "curl -s https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513",
  "echo 'never gh run cancel or gh run rerun'",
  "rg -n 'gh run cancel' ~/notes.md",
  "gh workflow run verify-dev.yml --ref ci/posts-logged-in-r6",
];

for (const [tool, texts] of [["bash", REFUSED_BASH], ["ipython", REFUSED_CELL]]) {
  for (const text of texts) {
    test(`refuses ${tool}: ${text.split("\n").join(" / ")}`, () => {
      for (const [who, file] of Object.entries(sessions)) {
        const result = call(tool, text, file);
        assert.equal(result?.block, true, `${who} ${tool}: ${text}`);
        assert.match(result.reason, /CI run guard: refused/);
        assert.match(result.reason, /never cancel or re-run any run/);
        assert.match(result.reason, /push a fresh run/);
        assert.match(result.reason, /send its id and why to Fable/);
      }
    });
  }
}

test("scope: runs of other repos pass, and auto-sns-agent's runs are refused from any checkout", () => {
  const checkIn = sessions["check-in 01a13b00"];
  const passes = [
    [SLACK_GREEN, "gh run rerun 38544915449 --failed"],
    [SLACK_GREEN, "gh api -X POST repos/{owner}/{repo}/actions/runs/38544915449/cancel"],
    [AUTO, "gh run rerun 38544915449 --repo sieu-n/slack-green --failed"],
    [AUTO, "gh -R sieu-n/slack-green run cancel 38544915449"],
    [AUTO, "gh run rerun 38544915449 -R https://github.com/sieu-n/slack-green"],
    [AUTO, "gh run cancel 38544915449 --repo=sieu-n/slack-green"],
    [AUTO, "GH_REPO=sieu-n/slack-green gh run cancel 38544915449"],
    [AUTO, `cd ${SLACK_GREEN} && gh run rerun 38544915449`],
    [AUTO, "gh api -X POST repos/sieu-n/slack-green/actions/runs/38544915449/rerun-failed-jobs"],
    [AUTO, "curl -X POST https://api.github.com/repos/sieu-n/slack-green/actions/runs/38544915449/cancel"],
  ];
  for (const [cwd, text] of passes) assert.equal(call("bash", text, checkIn, cwd), undefined, `${cwd}: ${text}`);
  // slack green guy (01a11b0b, cwd slack-green) at 08:43Z on 10-14.
  assert.equal(call("ipython", "r=await bash('gh run rerun 38530084509 --repo sieu-n/slack-green --failed 2>&1 | tail -1'); print(r.output)",
    `${agent}/sessions/01a11b0b-7c15-73da-9481-8de15903eab4.jsonl`, SLACK_GREEN), undefined);
  const refused = [
    [SLACK_GREEN, "gh run rerun 38492712967 --repo sieu-n/auto-sns-agent"],
    [SLACK_GREEN, "gh run cancel 38578797513 --repo Sieu-N/Auto-SNS-Agent"],
    [SLACK_GREEN, "GH_REPO=sieu-n/auto-sns-agent gh run cancel 38578797513"],
    [SLACK_GREEN, `cd ${AUTO} && gh run cancel 38578797513`],
    [SLACK_GREEN, "gh api -X POST repos/sieu-n/auto-sns-agent/actions/runs/38578797513/cancel"],
    [SLACK_GREEN, "curl -X POST https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513/cancel"],
    [AUTO, "gh api -X POST repos/{owner}/{repo}/actions/runs/38578797513/cancel"],
    [root, "gh run cancel 38578797513"],
  ];
  for (const [cwd, text] of refused) {
    const result = call("bash", text, checkIn, cwd);
    assert.equal(result?.block, true, `${cwd}: ${text}`);
    assert.match(result.reason, cwd === root ? /in a repo it does not name/ : /sieu-n\/auto-sns-agent/);
  }
});

test("a session the guard cannot place is refused", () => {
  const result = call("bash", "gh run cancel 38578797513");
  assert.equal(result?.block, true);
});

test("the release owner, Fable and their own subagents pass every form", () => {
  for (const [who, file] of Object.entries(keepers)) {
    for (const text of REFUSED_BASH) assert.equal(call("bash", text, file), undefined, `${who}: ${text}`);
    for (const text of REFUSED_CELL) assert.equal(call("ipython", text, file), undefined, `${who}: ${text}`);
  }
});

test("gh run view, gh run watch and other reads pass for everyone", () => {
  for (const file of [...Object.values(sessions), ...Object.values(keepers), undefined]) {
    for (const text of ALLOWED) assert.equal(call("bash", text, file), undefined, `${file}: ${text}`);
    assert.equal(call("ipython", "w=bash('gh run watch 38578797513 --interval 180'); v=await bash('gh run view 38578797513')", file), undefined);
    assert.equal(call("ipython", "await agent_message.send('please cancel 38578797513 (gh run cancel); I will not', receiver_role='parent')", file), undefined);
  }
});

test("replay: the three check-in commands of 10-14 are refused in their own sessions", () => {
  const cases = [
    // 01:13Z, check-in launch main bro 10-14 10:05 (01a137f6), sessions/01a137f6-dff5-766b-82df-6a5a0f59d5e7.jsonl:41
    ["01a137f6-dff5-766b-82df-6a5a0f59d5e7", "r=await bash('gh run rerun 38492712967 --failed 2>&1; sleep 3; gh run view 38492712967 --json attempt,status')\nprint(r.output)"],
    // 06:25Z, check-in launch main bro 15:23 (01a13914), sessions/01a13914-e196-74cf-8075-29cf843e0fe2.jsonl:41
    ["01a13914-e196-74cf-8075-29cf843e0fe2", "r=await bash('gh run cancel 38514703530 && sleep 20 && gh run view 38514703530 --json status,conclusion && gh run view 38520806029 --json jobs -q \"[.jobs[]|select(.status==\\\\\"in_progress\\\\\")|.name]\"')\nprint(r.output)"],
    // 15:24Z (00:24 KST), check-in launch main bro 00:20 (01a13b00), sessions/01a13b00-9ebb-73f9-80cc-138349f4bc7d.jsonl:73
    ["01a13b00-9ebb-73f9-80cc-138349f4bc7d", "r=await bash('gh run cancel 38578797513'); print(r.exit_code, r.output)"],
  ];
  for (const [id, code] of cases) {
    const result = call("ipython", code, `${agent}/sessions/${id}.jsonl`);
    assert.equal(result?.block, true, id);
    assert.match(result.reason, /CI run guard/, id);
  }
  // Fable's own cancel of the same run at 15:27Z, sessions/01a0cc5e-0ca4-762a-90e6-566c310bd50a.jsonl:36752, still runs.
  assert.equal(call("ipython", "print((await bash(\"gh run cancel 38578797513 --repo sieu-n/auto-sns-agent 2>&1|tail -1\")).output.strip())", keepers.Fable), undefined);
});

test("the kernel's run-time check refuses the same calls by the kernel's RLM_SESSION_DIR", () => {
  const check = (dir, input) => {
    process.env.RLM_SESSION_DIR = dir;
    try {
      return judgeCheck(input);
    } finally {
      delete process.env.RLM_SESSION_DIR;
    }
  };
  const checkIn = `${agent}/session-artifacts/01a13b00-9ebb-73f9-80cc-138349f4bc7d`;
  const fableChild = `${agent}/session-artifacts/${FABLE}/sub-5e6f7a8b`;
  const shell = { kind: "shell", text: "gh run cancel 38578797513", cwd: root };
  const post = { kind: "http", method: "POST", url: "https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513/cancel" };
  const del = { kind: "http", method: "DELETE", url: "https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513" };
  for (const input of [shell, post, del]) {
    const verdict = check(checkIn, input);
    assert.equal(verdict.block, true, JSON.stringify(input));
    assert.match(verdict.reason, /CI run guard/);
    assert.deepEqual(check(fableChild, input), { block: false }, JSON.stringify(input));
  }
  assert.deepEqual(check(checkIn, { kind: "shell", text: "gh run view 38578797513", cwd: root }), { block: false });
  assert.deepEqual(check(checkIn, { kind: "shell", text: "gh run rerun 38544915449 --failed", cwd: SLACK_GREEN }), { block: false });
  assert.deepEqual(check(checkIn, { kind: "http", method: "POST", url: "https://api.github.com/repos/sieu-n/slack-green/actions/runs/38544915449/rerun" }), { block: false });
  assert.deepEqual(check(checkIn, { kind: "http", method: "GET", url: "https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs/38578797513" }), { block: false });
});
