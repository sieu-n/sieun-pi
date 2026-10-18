// 10-18 ops report on us-metal02: jobs had copied repo trees into their wiki session folders (sessions/2026/10/18/1408-land-speed-takeover held 35),
// and content/sessions held 1.7M files, 1.3M of them in 502 copies, which the wiki index, git status and every walker paid for. A job's end now
// deletes the untracked copies in the session folders its transcripts opened, and keeps the session pages and the copies git tracks.
// At 16:46Z 41 `git archive <sha> apps/<app>` exports (1.9 GB), 3 bare mirrors (1.2 GB) and a .venv were still there, because only .git,
// pnpm-workspace.yaml and scripts/repo counted as a copy.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { endLeftovers, type LeftoverSource, openedWikiSessions, removeRepoCopies, repoCopies } from "../src/job-leftovers.ts";

function put(root: string, path: string, text = "x"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const SESSION = "sessions/2026/10/18/1408-land-speed-takeover";
const opened = `{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"201 {\\"id\\":\\"${SESSION}\\",\\"path\\":\\"${SESSION}/index.html\\",\\"version\\":1}\\n"}]}}\n`;

function wiki(): string {
  const content = mkdtempSync(join(tmpdir(), "job-copies-"));
  put(content, `${SESSION}/index.html`, "<h1>land speed takeover</h1>");
  put(content, `${SESSION}/report.md`, "# Report");
  put(content, `${SESSION}/data/run.log`);
  put(content, `${SESSION}/export-base/pnpm-workspace.yaml`);
  put(content, `${SESSION}/export-base/apps/llm-wiki/index.md`);
  put(content, `${SESSION}/drafts/clone/.git/HEAD`);
  put(content, `${SESSION}/drafts/notes.md`);
  put(content, `${SESSION}/drafts/scripts-only/scripts/repo/agent/commit.mjs`);
  put(content, `${SESSION}/tool/node_modules/x/index.js`);
  put(content, `${SESSION}/tool/package.json`);
  put(content, `${SESSION}/kept/pnpm-workspace.yaml`);
  put(content, `${SESSION}/data/mirror.git/HEAD`);
  put(content, `${SESSION}/data/mirror.git/objects/pack/p.pack`);
  put(content, `${SESSION}/data/mirror.git/refs/heads/main`);
  put(content, `${SESSION}/data/vent-src/apps/vent/pyproject.toml`);
  put(content, `${SESSION}/data/fixture/apps/vent/src/app.py`);
  put(content, `${SESSION}/tool/.venv/bin/python`);
  put(content, "sessions/2026/10/18/1950-tip-guard-reds/build/src/pnpm-workspace.yaml");
  return content;
}

test("the session folders a transcript opened come from the POST /api/agent/sessions answer, not from paths it only names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-transcript-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, opened + `{"text":"du: 167M\\t${"sessions/2026/10/18/1950-tip-guard-reds"}"}\n` + `{'id': 'sessions/2026/10/17/0901-py-dict', 'path': 'sessions/2026/10/17/0901-py-dict/index.html', 'version': 1}\n`);
  assert.deepEqual((await openedWikiSessions([file])).sort(), ["sessions/2026/10/17/0901-py-dict", SESSION]);
});

test("repo copies are the folders with .git, pnpm-workspace.yaml, scripts/repo, a bare repo or an app export, plus each node_modules and .venv, and nothing above them", async () => {
  const content = wiki();
  const found = (await repoCopies(join(content, SESSION))).map(path => path.slice(content.length + SESSION.length + 2)).sort();
  assert.deepEqual(found, ["data/mirror.git", "data/vent-src", "drafts/clone", "drafts/scripts-only", "export-base", "kept", "tool/.venv", "tool/node_modules"]);
});

test("a job's end deletes the untracked copies in the session folders it opened and keeps its pages, tracked copies and other sessions", async () => {
  const content = wiki();
  const dir = mkdtempSync(join(tmpdir(), "job-tree-"));
  put(dir, "sub-1/01a14d68-e374-7628-af49-123296f33292.jsonl", opened);
  const source: LeftoverSource = {
    strays: async () => [], started: async () => null, kill: () => {}, closeTabs: async () => 0, later: () => {},
    removeCopies: transcripts => removeRepoCopies(transcripts, content, async (_root, path) => path.endsWith("/kept")),
    tmpTrees: async () => [], inside: async () => [], removeTmp: async () => [], artifactCopies: async () => [], kernelStates: async () => [],
  };
  const left = await endLeftovers(source, dir);
  assert.equal(left.copies.length, 7);
  for (const gone of ["export-base", "drafts/clone", "drafts/scripts-only", "tool/node_modules", "tool/.venv", "data/mirror.git", "data/vent-src"]) assert.ok(!existsSync(join(content, SESSION, gone)), gone);
  for (const kept of ["index.html", "report.md", "data/run.log", "data/fixture/apps/vent/src/app.py", "drafts/notes.md", "tool/package.json", "kept/pnpm-workspace.yaml"]) assert.ok(existsSync(join(content, SESSION, kept)), kept);
  assert.ok(existsSync(join(content, "sessions/2026/10/18/1950-tip-guard-reds/build/src/pnpm-workspace.yaml")));
});
