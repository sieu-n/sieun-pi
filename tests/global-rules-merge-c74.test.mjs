import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Owner rule c74 (2026-10-15): "Until the proper launch, the owner pre-approves every prod promote, merge or push to main." On 10-15 the merge
// guard refused slack green guy's merge of #254 with the c49 text and still wanted OWNER_OK=<chat>/<todo>. While releaseGo.preapproval is set,
// every merge and default-branch push passes with no token; with it null the c49 refusals return. An outside send (c37) keeps its todo either way.
// Nothing here runs gh or pushes; the scratch repo's remote URL is never contacted.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-merge-c74-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const data = join(root, "chat");
mkdirSync(join(data, "boards"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = data;
const guard = await import("../components/global-rules/guard.ts");
const { C74, releaseGo } = await import("../components/user-history/src/shared/release-go.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const CHAT = "01a00000-0000-7000-8000-0000000000c7";
writeFileSync(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], updatedAt: "2026-10-15T00:00:00.000Z", todos: [
  { id: "t1", text: "Send this reply to support@vendor.example?", choices: ["Send it", "Not yet"], from: "agent", at: "2026-10-15T00:00:00.000Z", done: true, reply: "Send it", answeredBy: "owner" },
] }));
const PI = join(root, "pi");
mkdirSync(PI);
execFileSync("git", ["-C", PI, "init", "-q", "-b", "main"], { stdio: "ignore" });
execFileSync("git", ["-C", PI, "remote", "add", "origin", "https://github.com/sieu-n/slack-green.git"], { stdio: "ignore" });

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });
function withSwitch(preapproval, body) {
  const before = releaseGo.preapproval;
  releaseGo.preapproval = preapproval;
  try { return body(); } finally { releaseGo.preapproval = before; }
}

const MERGES = [
  "gh pr merge 254 --squash",
  "gh pr merge 225 --auto --squash --delete-branch",
  "gh pr merge -R sieu-n/slack-green 255 --squash",
  "gh pr merge --auto --squash",
  "gh api -X PUT repos/sieu-n/slack-green/pulls/250/merge -f merge_method=squash",
  `cd ${PI} && git push origin HEAD:main`,
  "git push https://github.com/sieu-n/slack-green.git HEAD:refs/heads/main",
  "gh api -X PATCH repos/sieu-n/slack-green/git/refs/heads/main -f sha=abc",
];
const PY_MERGE = 'import requests\nrequests.put("https://api.github.com/repos/sieu-n/slack-green/pulls/252/merge", json={"merge_method": "squash"})';
const SEND = "curl -sS -X POST https://acme.zendesk.com/api/v2/tickets/1.json -d '{\"ticket\":{\"comment\":{\"body\":\"hi\"}}}'";

test("c74: the switch holds the rule's id and date and is on", () => {
  assert.equal(releaseGo.preapproval, C74);
  assert.equal(C74.rule, "c74");
  assert.equal(C74.date, "2026-10-15");
});

test("c74: slack green guy's merges of #225 to #255 and pushes to main pass with no OWNER_OK", () => {
  for (const text of MERGES) assert.equal(call("bash", text), undefined, text);
  assert.equal(call("ipython", PY_MERGE), undefined);
  assert.equal(call("ipython", 'bash("gh pr merge 253 --squash")'), undefined);
});

test("c74: with the switch off the same commands are refused with the c49 reason", () => {
  withSwitch(null, () => {
    for (const text of MERGES) {
      const result = call("bash", text);
      assert.equal(result?.block, true, text);
      assert.match(result.reason, /merge guard: refused.*\(correction c49\)/, text);
    }
    assert.equal(call("ipython", PY_MERGE)?.block, true);
  });
});

test("c74 control: an outside send still needs the owner's ok on its todo while the switch is on", () => {
  const result = call("bash", SEND);
  assert.equal(result?.block, true);
  assert.doesNotMatch(result.reason, /merge guard/);
  assert.equal(call("bash", `OWNER_OK=${CHAT}/t1 ${SEND}`), undefined, "the approved todo lets that one send through");
  assert.equal(call("bash", `OWNER_OK=${CHAT}/t9 ${SEND}`)?.block, true);
});
