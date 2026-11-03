import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { boxRecordPath, closeTabs, jobSessionDir, onAgentEnd, registryPath } from "../src/aside-tabs.ts";

let root: string;
let ran: string;

before(() => {
	root = mkdtempSync(join(tmpdir(), "aside-tabs-"));
	ran = join(root, "ran.txt");
	const fake = join(root, "fake-python");
	writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$RLM_SESSION_DIR" "$PYTHONPATH" "$3" >> ${JSON.stringify(ran)}\n`);
	chmodSync(fake, 0o755);
	process.env.GLOBAL_RULES_ASIDE_PYTHON = fake;
	process.env.ASIDE_BROWSER_STATE = join(root, "owners");
	process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
	mkdirSync(process.env.ASIDE_BROWSER_STATE, { recursive: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

function session(file: string, header: Record<string, unknown> = {}) {
	return { sessionManager: { getSessionFile: () => file, getSessionId: () => "id", getHeader: () => header } } as never;
}

function record(sessionDir: string): void {
	writeFileSync(registryPath(sessionDir), JSON.stringify({ owner: sessionDir, tabs: { T1: "http://localhost:5180/" } }));
}

async function ranLines(count: number): Promise<string[]> {
	for (let i = 0; i < 100 && !(existsSync(ran) && readFileSync(ran, "utf8").trim().split("\n").length >= count); i++) await new Promise((r) => setTimeout(r, 20));
	return existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : [];
}

test("a job's turn end runs close_own_tabs for its own session dir, from this release's aside_browser", async () => {
	const job = join(root, "agent", "session-artifacts", "root-1", "sub-ab12");
	record(job);
	onAgentEnd(session(join(job, "01a1.jsonl"), { rlmDepth: 1 }));
	const [line] = await ranLines(1);
	const [dir, pythonPath, code] = line.split("|");
	assert.equal(dir, job);
	assert.match(pythonPath, /skills\/aside-browser\/src$/);
	assert.match(code, /aside_browser\.close_own_tabs\(\)/);
	assert.match(readFileSync(process.env.GLOBAL_RULES_LOG!, "utf8"), /\[aside-tabs\] closing the tabs of .*sub-ab12/);
});

test("a top-level chat keeps its tabs and a job with no tab record starts nothing", async () => {
	const chat = join(root, "agent", "sessions", "root-2.jsonl");
	const chatDir = jobSessionDir(session(chat));
	assert.equal(chatDir, null);
	record(join(root, "agent", "session-artifacts", "root-2"));
	onAgentEnd(session(chat, {}));
	assert.equal(closeTabs(join(root, "agent", "session-artifacts", "root-3", "sub-none"), "all"), false);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await ranLines(1)).length, 1);
});

test("a top-level chat's turn end stops its box Chrome, which nobody looks at, since 11-02 walk tabs reran 41 GB of staging Convex", async () => {
	const chat = join(root, "agent", "sessions", "root-4.jsonl");
	const dir = join(root, "agent", "session-artifacts", "root-4");
	writeFileSync(boxRecordPath(dir), JSON.stringify({ owner: dir, pid: 1 }));
	assert.match(boxRecordPath(dir), /\/[0-9a-f]{16}\.box$/);
	onAgentEnd(session(chat, {}));
	const lines = await ranLines(2);
	const [ranDir, , code] = lines[lines.length - 1].split("|");
	assert.equal(ranDir, dir);
	assert.match(code, /aside_browser\.stop_box\(\)/);
});

test("depth from the header counts as well as a sub-<n> folder", () => {
	assert.equal(jobSessionDir(session(join(root, "agent", "session-artifacts", "r", "sub-x", "a.jsonl"))), join(root, "agent", "session-artifacts", "r", "sub-x"));
	assert.equal(jobSessionDir(session(join(root, "agent", "sessions", "r.jsonl"), { parentSession: "p" })), join(root, "agent", "session-artifacts", "r"));
	assert.equal(jobSessionDir(undefined), null);
});
