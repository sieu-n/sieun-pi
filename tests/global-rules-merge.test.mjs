import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The merge guard (owner correction c49): a PR merges, or main or master moves, only with the owner's go on a For you todo that
// names that PR or that repo and push. Nothing here runs gh or pushes; the scratch repos have a remote URL that is never contacted.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-merge-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const data = join(root, "chat");
mkdirSync(join(data, "boards"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, AGENT_CHAT_DATA_DIR: process.env.AGENT_CHAT_DATA_DIR };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = data;
const guard = await import("../components/global-rules/guard.ts");
const { prSubject, pushSubject } = await import("../components/global-rules/merge-guard.ts");
// These tests hold the c49 guard as it runs with the c74 standing go off; global-rules-merge-c74.test.mjs covers the switch on.
const { releaseGo } = await import("../components/user-history/src/shared/release-go.ts");
releaseGo.preapproval = null;
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const CHAT = "01a00000-0000-7000-8000-0000000000c4";
const at = "2026-10-12T00:00:00.000Z";
const todo = (id, text, extra) => ({ id, text, choices: ["Merge it", "Not yet"], from: "agent", at, ...extra });
const go = { done: true, reply: "Merge it", answeredBy: "owner" };
writeFileSync(join(data, "boards", `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], updatedAt: at, todos: [
  todo("t1", "Merge PR #123 (fix login) into main?", go),
  todo("t2", "Merge PR #1234 into main?", go),
  todo("t3", "Merge the release PRs once checks pass?", go),
  todo("t4", "Merge PR #123 into main?", { done: true, reply: "Not yet", answeredBy: "owner" }),
  todo("t5", "Turn on auto-merge for PR #123 (node PR_kwDOAbc1)?", go),
  todo("t6", "When the sieun-pi push is ready, it covers about 24 local commits. Push them to the public repo then?", { done: true, reply: "Go, push when ready", answeredBy: "owner" }),
  todo("t7", "Push slack-green main to GitHub?", go),
] }));

const repo = (dir, branch, origin) => {
  const path = join(root, dir);
  mkdirSync(path);
  const git = (...args) => execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", branch);
  if (origin) git("remote", "add", "origin", origin);
  return path;
};
const PI = repo("pi", "main", "https://github.com/sieu-n/sieun-pi.git");
const FEATURE = repo("feature", "feature", "https://github.com/sieu-n/sieun-pi.git");
const LOCAL = repo("local", "main", null);

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });

function blocked(toolName, texts, why = /merge guard/) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, why, `${toolName}: ${text}`);
  }
}
function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

const AUTO_QUERY = `mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_kwDOAbc1", mergeMethod: SQUASH}) { clientMutationId } }`;
const MERGE_QUERY = `mutation { mergePullRequest(input: {pullRequestId: "PR_kwDOAbc1"}) { clientMutationId } }`;

test("gh pr merge is refused with every merge flag, and the reason says to ask on a For you todo", () => {
  blocked("bash", [
    "gh pr merge 123",
    "gh pr merge 123 --auto",
    "gh pr merge 123 --squash --auto --delete-branch",
    "gh pr merge 123 --merge",
    "gh pr merge 123 --rebase",
    "gh pr merge 123 --admin --squash",
    "gh pr merge -R sieu-n/auto-sns-agent 123 --squash",
    "gh pr merge https://github.com/sieu-n/auto-sns-agent/pull/123 --auto",
    "/opt/homebrew/bin/gh pr merge 123 -s",
  ]);
  const result = call("bash", "gh pr merge 123 --auto");
  assert.match(result.reason, /PR #123 with auto-merge/);
  assert.match(result.reason, /c49/);
  assert.match(result.reason, /For you todo/);
  assert.match(result.reason, /OWNER_OK=<chat id>\/<todo id>/);
});

test("a merge that does not name a PR number is refused and no todo can approve it", () => {
  blocked("bash", ["gh pr merge", "gh pr merge --auto --squash", "gh pr merge my-branch --squash"], /does not name the PR by number/);
  blocked("bash", [`OWNER_OK=${CHAT}/t1 gh pr merge --auto`], /does not name the PR by number/);
});

test("REST and GraphQL merges through gh api and curl are refused", () => {
  blocked("bash", [
    "gh api -X PUT repos/sieu-n/auto-sns-agent/pulls/123/merge",
    "gh api --method=PUT /repos/sieu-n/auto-sns-agent/pulls/123/merge -f merge_method=squash",
    "gh api -XPUT repos/o/r/pulls/123/merge",
    "gh api repos/o/r/pulls/123/merge -f merge_method=squash",
    "gh api -X POST repos/o/r/merges -f base=main -f head=feature",
    `gh api graphql -f query='${AUTO_QUERY}'`,
    `gh api graphql -f query='${MERGE_QUERY}'`,
    `gh api graphql -f query='mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' -f id=PR_kwDOAbc1`,
    "curl -sS -X PUT -H 'Authorization: Bearer x' https://api.github.com/repos/o/r/pulls/123/merge -d '{\"merge_method\":\"squash\"}'",
    "curl -X PUT https://ghe.example.com/api/v3/repos/o/r/pulls/123/merge",
    `curl -sS https://api.github.com/graphql -H 'Authorization: bearer x' -d '{"query":"${MERGE_QUERY.replaceAll('"', '\\"')}"}'`,
  ]);
});

test("shell wrappers, substitutions, eval, env tricks and heredocs do not slip past", () => {
  blocked("bash", [
    "bash -lc 'gh pr merge 123 --auto'",
    `sh -c "cd repo && gh pr merge 123 --squash"`,
    "zsh -c 'bash -c \"gh pr merge 123 --auto\"'",
    "echo $(gh pr merge 123 --auto)",
    "echo `gh pr merge 123`",
    "(cd repo; gh pr merge 123 --auto)",
    "env GH_TOKEN=x GH_REPO=o/r gh pr merge 123 --auto",
    "GH_PROMPT_DISABLED=1 nohup gh pr merge 123 --auto &",
    "timeout 30 gh pr merge 123 --auto",
    "sudo -u sieun gh pr merge 123",
    "eval \"gh pr merge 123 --auto\"",
    "echo 123 | xargs gh pr merge --auto",
    "ssh build-box gh pr merge 123 --auto",
    "if true; then gh pr merge 123 --auto; fi",
    "bash <<'EOF'\ncd repo\ngh pr merge 123 --auto\nEOF",
    "ssh build-box bash -s <<EOF\ngh pr merge 123\nEOF",
    `gh api graphql --input - <<'EOF'\n{"query": "${AUTO_QUERY.replaceAll('"', '\\"')}"}\nEOF`,
    `curl -sS -d @- https://api.github.com/graphql <<'EOF'\n{"query": "${MERGE_QUERY.replaceAll('"', '\\"')}"}\nEOF`,
    "gh alias set m 'pr merge --auto'",
  ]);
});

test("a GraphQL body in a file is read", () => {
  writeFileSync(join(root, "q.graphql"), AUTO_QUERY);
  writeFileSync(join(root, "body.json"), JSON.stringify({ query: MERGE_QUERY }));
  blocked("bash", ["gh api graphql -F query=@q.graphql", "gh api graphql --input body.json", "curl -d @body.json https://api.github.com/graphql"]);
});

test("ipython cells: bash, subprocess, ! escapes, %%bash, and Python HTTP writes are refused", () => {
  blocked("ipython", [
    `h = bash("gh pr merge 123 --auto")`,
    `await bash('cd /repo && gh pr merge 123 --squash')`,
    `subprocess.run(["gh", "pr", "merge", "123", "--auto"])`,
    `!gh pr merge 123 --auto`,
    `%%bash\ngh pr merge 123 --auto`,
    `import requests\nrequests.put("https://api.github.com/repos/o/r/pulls/123/merge", headers=h, json={"merge_method": "squash"})`,
    `url = "https://api.github.com/repos/o/r/pulls/123/merge"\nhttpx.request("PUT", url, headers=h)`,
    `requests.post("https://api.github.com/graphql", json={"query": ${JSON.stringify(AUTO_QUERY)}}, headers=h)`,
  ]);
});

test("reading PRs, turning auto-merge off, help and plain text about merges pass", () => {
  allowed("bash", [
    "gh pr view 123",
    "gh pr checks 123 --watch",
    "gh pr list --state merged",
    "gh pr merge 123 --disable-auto",
    "gh pr merge --help",
    "gh api repos/o/r/pulls/123/merge",
    "gh api repos/o/r/pulls/123",
    "gh api graphql -f query='query { repository(owner: \"o\", name: \"r\") { pullRequest(number: 123) { mergeable } } }'",
    "curl -sS https://api.github.com/repos/o/r/pulls/123/merge",
    "echo 'gh pr merge 123 --auto'",
    "rg -n 'gh pr merge' scripts",
    "git log --merges -5",
    "cat > notes.md <<'EOF'\ngh pr merge 123 --auto\nEOF",
  ]);
  allowed("ipython", [
    `print("gh pr merge 123 --auto")`,
    `# bash("gh pr merge 123")`,
    `requests.get("https://api.github.com/repos/o/r/pulls/123/merge")`,
    `note = ${JSON.stringify(AUTO_QUERY)}\nopen("q.graphql", "w").write(note)`,
  ]);
});

test("an approved todo that names the PR lets that merge through; another PR, a hold or a standing go keeps the block", () => {
  allowed("bash", [
    `OWNER_OK=${CHAT}/t1 gh pr merge 123 --auto --squash`,
    `OWNER_OK=${CHAT}/t1 gh api -X PUT repos/o/r/pulls/123/merge`,
    `OWNER_OK=${CHAT}/t1 curl -X PUT https://api.github.com/repos/o/r/pulls/123/merge`,
    `OWNER_OK=${CHAT}/t5 gh api graphql -f query='${AUTO_QUERY}'`,
  ]);
  allowed("ipython", [`# OWNER_OK=${CHAT}/t1\nh = bash("gh pr merge 123 --auto")`]);
  blocked("bash", [`OWNER_OK=${CHAT}/t1 gh pr merge 124 --auto`, `OWNER_OK=${CHAT}/t1 gh pr merge 12`], /does not name PR #12/);
  blocked("bash", [`OWNER_OK=${CHAT}/t2 gh pr merge 123`], /does not name PR #123/);
  blocked("bash", [`OWNER_OK=${CHAT}/t3 gh pr merge 123`], /does not name PR #123/);
  blocked("bash", [`OWNER_OK=${CHAT}/t4 gh pr merge 123`], /not a go/);
  blocked("bash", [`OWNER_OK=${CHAT}/t1 gh api graphql -f query='${AUTO_QUERY}'`], /does not name PR_kwDOAbc1/);
  blocked("bash", [`OWNER_OK=${CHAT}/t1 gh pr merge 123 && gh pr merge 124`], /does not name PR #124/);
});

test("a todo names a PR, or a repo and its push, in the usual ways", () => {
  const pr = prSubject("123").pattern;
  for (const text of ["Merge #123?", "Merge PR 123?", "merge pr #123 now", "Merge pull request 123", "https://github.com/o/r/pull/123 ok?"]) assert.equal(pr.test(text), true, text);
  for (const text of ["Merge #1234?", "Merge PR 12", "Merge 123 files", "Merge the release PRs"]) assert.equal(pr.test(text), false, text);
  const push = pushSubject("sieun-pi", "main").pattern;
  for (const text of ["Push sieun-pi to the public repo?", "Move sieun-pi main to origin?", "push SIEUN-PI now"]) assert.equal(push.test(text), true, text);
  for (const text of ["Push slack-green main?", "sieun-pi-check main push?", "Clean up sieun-pi history?"]) assert.equal(push.test(text), false, text);
});

test("git push to main or master is refused in any repo, through every refspec form and wrapper", () => {
  blocked("bash", [
    `cd ${PI} && git push origin main`,
    `git -C ${PI} push origin HEAD:main`,
    `git -C ${LOCAL} push origin +main`,
    `git -C ${LOCAL} push --force-with-lease origin HEAD:refs/heads/master`,
    `git -C ${PI} push origin feature:master`,
    `git -C ${PI} push origin --delete master`,
    `git -C ${PI} push origin :main`,
    `git -C ${PI} push --all origin`,
    `git -C ${PI} push --mirror origin`,
    `git -C ${PI} push`,
    `git -C ${PI} push -u origin HEAD`,
    `git -C ${LOCAL} push origin main`,
    "git push https://github.com/sieu-n/slack-green.git main",
    `bash -lc 'cd ${PI} && git push origin main'`,
    `env GIT_SSH_COMMAND=ssh /usr/bin/git -C ${PI} push origin main`,
    `bash <<'EOF'\ncd ${PI}\ngit push origin main\nEOF`,
  ], /lands on main or master/);
  assert.match(call("bash", `git -C ${PI} push origin main`).reason, /moves main on sieun-pi/);
  allowed("bash", [
    `git -C ${PI} push origin feature`,
    `git -C ${FEATURE} push`,
    `git -C ${FEATURE} push -u origin HEAD`,
    "git push origin sieun/dev",
    `git -C ${PI} push origin --tags`,
    `git -C ${PI} push --dry-run origin main`,
    `git -C ${PI} log origin/main..main`,
  ]);
});

test("ref updates on a default branch through the refs API and GraphQL are refused", () => {
  blocked("bash", [
    "gh api -X PATCH repos/sieu-n/sieun-pi/git/refs/heads/main -f sha=abc123",
    "gh api -X DELETE repos/o/r/git/refs/heads/master",
    "gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc123",
    "curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/master -d '{\"sha\":\"abc\",\"force\":true}'",
    `gh api graphql -f query='mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/r", branchName: "main"}, expectedHeadOid: "abc", message: {headline: "x"}}) { commit { oid } } }'`,
    `gh api graphql -f query='mutation { updateRef(input: {refId: "REF_kwDO1", oid: "abc"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { updateRefs(input: {repositoryId: "R_1", refUpdates: [{name: "refs/heads/main", afterOid: "abc"}]}) { clientMutationId } }'`,
  ], /lands on main or master/);
  blocked("ipython", [`import requests\nrequests.patch("https://api.github.com/repos/o/r/git/refs/heads/main", json={"sha": "abc"}, headers=h)`], /moves main on r/);
  allowed("bash", [
    "gh api repos/o/r/git/refs/heads/main",
    "gh api -X PATCH repos/o/r/git/refs/heads/feature -f sha=abc123",
    `gh api graphql -f query='mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/r", branchName: "docs-fix"}}) { commit { oid } } }'`,
  ]);
});

test("staging lands need no owner ok (c50): pushes, ref updates and branch merges into staging pass, and main still refuses", () => {
  allowed("bash", [
    `git -C ${PI} push origin HEAD:staging`,
    `git -C ${PI} push origin feature:refs/heads/staging`,
    `git -C ${LOCAL} push origin +staging`,
    "git push https://github.com/sieu-n/auto-sns-agent.git sieun/dev:staging",
    "gh api -X PATCH repos/sieu-n/auto-sns-agent/git/refs/heads/staging -f sha=abc123 -F force=true",
    "curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/staging -d '{\"sha\":\"abc\"}'",
    `gh api graphql -f query='mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/r", branchName: "staging"}}) { commit { oid } } }'`,
    "gh api -X POST repos/o/r/merges -f base=staging -f head=sieun/dev",
    `gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "R_1", base: "staging", head: "sieun/dev"}) { clientMutationId } }'`,
  ]);
  blocked("bash", [
    `git -C ${PI} push origin HEAD:main`,
    "gh api -X PATCH repos/sieu-n/auto-sns-agent/git/refs/heads/main -f sha=abc123",
    `gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "R_1", base: "main", head: "staging"}) { clientMutationId } }'`,
  ], /lands on main or master/);
  blocked("bash", ["gh pr merge 123 --squash"], /PR #123/);
});

test("an approved todo that names the repo and push lets that push through; a todo for another repo or a PR does not", () => {
  allowed("bash", [
    `OWNER_OK=${CHAT}/t6 git -C ${PI} push origin main`,
    `OWNER_OK=${CHAT}/t6 gh api -X PATCH repos/sieu-n/sieun-pi/git/refs/heads/main -f sha=abc123`,
    `OWNER_OK=${CHAT}/t7 git push https://github.com/sieu-n/slack-green.git main`,
  ]);
  blocked("bash", [`OWNER_OK=${CHAT}/t1 git -C ${PI} push origin main`, `OWNER_OK=${CHAT}/t7 git -C ${PI} push origin main`], /does not name the main push to sieun-pi/);
  blocked("bash", [`OWNER_OK=${CHAT}/t6 gh api graphql -f query='mutation { updateRef(input: {refId: "REF_kwDO1", oid: "abc"}) { clientMutationId } }'`], /does not name the PR number, or the repo and branch/);
});
