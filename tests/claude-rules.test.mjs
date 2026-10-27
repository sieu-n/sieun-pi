import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CUSTOM_TYPE, globRegex, register } from "../components/claude-rules/rules.ts";
import { cellStart, cellSteps } from "../packages/sieun-rules/src/kernel-cwd.ts";

// A Prime session in a repo with .claude/rules gets the unscoped rules first in every model call, and a scoped rule once,
// appended to the result of the first tool call that reads or edits a file its paths match.
const repo = mkdtempSync(join(tmpdir(), "claude-rules-"));
test.after(() => rmSync(repo, { recursive: true, force: true }));
mkdirSync(join(repo, ".claude", "rules", "apps"), { recursive: true });
for (const dir of ["src", "tests", "apps/web/src", "x/tests"]) mkdirSync(join(repo, dir), { recursive: true });
for (const file of ["src/main.ts", "src/a.test.ts", "tests/b.py", "apps/web/src/page.svelte", "x/tests/c.py"]) writeFileSync(join(repo, file), "");
writeFileSync(join(repo, ".claude", "rules", "always.md"), "# Always\n\nALWAYS-RULE-BODY\n");
writeFileSync(join(repo, ".claude", "rules", "testing.md"), "---\npaths:\n  - '**/tests/**'\n  - '**/*.test.*'\n---\n\n# Testing\n\nTESTING-RULE-BODY\n");
writeFileSync(join(repo, ".claude", "rules", "apps", "web.md"), "---\npaths: 'apps/web/**/*.{ts,svelte}'\n---\nWEB-RULE-BODY\n");

function session(branch = []) {
	const handlers = new Map();
	const entries = [...branch];
	const pi = {
		on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
	register(pi, { cellStart, cellSteps });
	const ctx = { cwd: repo, sessionManager: { getBranch: () => entries, getSessionFile: () => null } };
	const emit = async (name, event) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	const context = async (messages) => (await emit("context", { type: "context", messages }))?.messages ?? messages;
	const cell = async (code) => {
		const content = [{ type: "text", text: "cell output" }];
		const result = await emit("tool_result", { type: "tool_result", toolName: "ipython", toolCallId: "t", input: { code }, content, isError: false });
		return (result?.content ?? content).map((part) => part.text).join("\n");
	};
	return { context, cell, emit, entries };
}

const user = { role: "user", content: [{ type: "text", text: "add a test" }], timestamp: 1 };
const textOf = (messages) => JSON.stringify(messages);

test("an unscoped rule is first in the context from the first call, and a scoped one is not", async () => {
	const s = session();
	const messages = await s.context([user]);
	assert.equal(messages[0].customType, CUSTOM_TYPE);
	assert.match(messages[0].content, /ALWAYS-RULE-BODY/);
	assert.doesNotMatch(textOf(messages), /TESTING-RULE-BODY|WEB-RULE-BODY/);
	assert.deepEqual(messages.slice(1), [user]);
});

test("a word in code that names no file in the repo loads nothing", async () => {
	const s = session();
	assert.doesNotMatch(await s.cell("bash('cd ~/elsewhere && cat tests/other.test.mjs')"), /TESTING-RULE-BODY/);
});

test("the start-up message is the same text on every call, so the cached prefix holds", async () => {
	const s = session();
	const first = await s.context([user]);
	await s.cell("open('src/a.test.ts').read()");
	const later = await s.context([user, { role: "assistant", content: [], timestamp: 2 }]);
	assert.deepEqual(later[0], first[0]);
});

test("a scoped rule loads on the first matching read, once, and never on a second match", async () => {
	const s = session();
	assert.doesNotMatch(await s.cell("print(open('src/main.ts').read())"), /TESTING-RULE-BODY/);
	const first = await s.cell("print(open('src/a.test.ts').read())");
	assert.match(first, /^cell output\n/);
	assert.match(first, /TESTING-RULE-BODY/);
	assert.doesNotMatch(first, /ALWAYS-RULE-BODY/, "an unscoped rule already in the start-up message is not appended again");
	assert.doesNotMatch(await s.cell("await edit(path='tests/b.py', old_str='a', new_str='b')"), /TESTING-RULE-BODY/);
	assert.equal(s.entries.filter((e) => e.customType === CUSTOM_TYPE).length, 1);
});

test("a cell's os.chdir and absolute paths count, and brace globs match", async () => {
	const s = session();
	const out = await s.cell(`import os\nos.chdir(${JSON.stringify(join(repo, "apps"))})\nopen('web/src/page.svelte').read()`);
	assert.match(out, /WEB-RULE-BODY/);
	assert.match(await s.cell(`open(${JSON.stringify(join(repo, "x", "tests", "c.py"))})`), /TESTING-RULE-BODY/);
	assert.ok(globRegex("apps/web/**/*.{ts,svelte}").test("apps/web/page.ts"));
	assert.ok(!globRegex("apps/web/**/*.{ts,svelte}").test("apps/web/page.js"));
	assert.ok(globRegex("**/*.test.*").test("a.test.ts"));
});

test("a resumed session keeps a rule it already loaded, and a compaction lets it load again", async () => {
	const s = session([{ type: "custom", customType: CUSTOM_TYPE, data: { files: [join(repo, ".claude", "rules", "testing.md")] } }]);
	assert.doesNotMatch(await s.cell("open('src/a.test.ts')"), /TESTING-RULE-BODY/);
	await s.emit("session_compact", { type: "session_compact" });
	assert.match(await s.cell("open('src/a.test.ts')"), /TESTING-RULE-BODY/);
	const fresh = session([...s.entries, { type: "compaction" }]);
	assert.match(await fresh.cell("open('src/a.test.ts')"), /TESTING-RULE-BODY/);
});

test("a session started outside the repo gets the repo's unscoped rules with its first touch there", async () => {
	const handlers = new Map();
	const pi = { on: (name, handler) => handlers.set(name, handler), appendEntry: () => {} };
	register(pi, { cellStart, cellSteps });
	const ctx = { cwd: tmpdir(), sessionManager: { getBranch: () => [] } };
	assert.equal(handlers.get("context")({ type: "context", messages: [user] }, ctx), undefined);
	const result = handlers.get("tool_result")({ toolName: "ipython", input: { code: `open(${JSON.stringify(join(repo, "src", "a.test.ts"))})` }, content: [] }, ctx);
	const text = result.content.map((p) => p.text).join("\n");
	assert.match(text, /ALWAYS-RULE-BODY/);
	assert.match(text, /TESTING-RULE-BODY/);
});

test("a session whose cwd reaches the repo through a link gets no unscoped rule twice", async () => {
	const link = `${repo}-link`;
	symlinkSync(repo, link);
	const handlers = new Map();
	register({ on: (name, handler) => handlers.set(name, handler), appendEntry: () => {} }, { cellStart, cellSteps });
	const ctx = { cwd: link, sessionManager: { getBranch: () => [] } };
	assert.match(handlers.get("context")({ type: "context", messages: [user] }, ctx).messages[0].content, /ALWAYS-RULE-BODY/);
	const result = handlers.get("tool_result")({ toolName: "ipython", input: { code: `open(${JSON.stringify(join(repo, "src", "a.test.ts"))})` }, content: [] }, ctx);
	const text = result.content.map((part) => part.text).join("\n");
	assert.match(text, /TESTING-RULE-BODY/);
	assert.doesNotMatch(text, /ALWAYS-RULE-BODY/);
	rmSync(link);
});
