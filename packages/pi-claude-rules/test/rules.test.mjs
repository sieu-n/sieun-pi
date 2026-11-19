import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CUSTOM_TYPE, globRegex, register } from "../src/core/rules.ts";
import { kernelCwd, sessionCwd } from "../src/pi/index.ts";
import { cellStart, cellSteps } from "../../sieun-rules/src/kernel-cwd.ts";

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
// A home folder with no .claude/rules, so the user rules of the box that runs the tests stay out of them.
const nohome = join(repo, "nohome");
mkdirSync(nohome);

function session(branch = [], home = nohome) {
	const handlers = new Map();
	const entries = [...branch];
	const pi = {
		on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
	register(pi, { cellStart, cellSteps }, home);
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

test("a user rule in ~/.claude/rules loads in any repo, with its globs read against that repo, and its unscoped rule starts every session", async () => {
	const home = join(repo, "home");
	mkdirSync(join(home, ".claude", "rules"), { recursive: true });
	writeFileSync(join(home, ".claude", "rules", "ts.md"), "---\npaths:\n  - '**/*.{ts,tsx}'\n---\nUSER-TS-RULE-BODY\n");
	writeFileSync(join(home, ".claude", "rules", "all.md"), "USER-ALWAYS-RULE-BODY\n");
	const s = session([], home);
	const messages = await s.context([user]);
	assert.match(messages[0].content, /ALWAYS-RULE-BODY[\s\S]*USER-ALWAYS-RULE-BODY/);
	assert.doesNotMatch(await s.cell("open('tests/b.py').read()"), /USER-TS-RULE-BODY/);
	const first = await s.cell("open('src/main.ts').read()");
	assert.match(first, /USER-TS-RULE-BODY/);
	assert.doesNotMatch(first, /USER-ALWAYS-RULE-BODY/);
	assert.doesNotMatch(await s.cell("open('apps/web/src/page.svelte').read()"), /USER-TS-RULE-BODY/);
	assert.ok(globRegex("**/*.{ts,tsx}").test("src/main.ts"));
});

test("sieun-pi's user rules each have a manifest link, and the web rule loads for a Svelte file but not for a server TypeScript file", async () => {
	const root = join(import.meta.dirname, "..", "..", "..");
	const shipped = readdirSync(join(root, "config", "claude-rules")).filter((name) => name.endsWith(".md"));
	const links = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8")).entries ?? [];
	for (const name of shipped) assert.ok(JSON.stringify(links).includes(`"config/claude-rules/${name}"`), `${name} has an install-manifest link`);
	const home = join(repo, "shipped-home");
	mkdirSync(join(home, ".claude", "rules"), { recursive: true });
	for (const name of shipped) symlinkSync(join(root, "config", "claude-rules", name), join(home, ".claude", "rules", name));
	const s = session([], home);
	const svelte = await s.cell("open('apps/web/src/page.svelte').read()");
	assert.match(svelte, /modern-web-guidance/);
	assert.doesNotMatch(svelte, /typescript-best-practices/);
	const ts = await s.cell("open('src/main.ts').read()");
	assert.match(ts, /typescript-best-practices/);
	assert.doesNotMatch(ts, /modern-web-guidance/);
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
	register(pi, { cellStart, cellSteps }, nohome);
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
	register({ on: (name, handler) => handlers.set(name, handler), appendEntry: () => {} }, { cellStart, cellSteps }, nohome);
	const ctx = { cwd: link, sessionManager: { getBranch: () => [] } };
	assert.match(handlers.get("context")({ type: "context", messages: [user] }, ctx).messages[0].content, /ALWAYS-RULE-BODY/);
	const result = handlers.get("tool_result")({ toolName: "ipython", input: { code: `open(${JSON.stringify(join(repo, "src", "a.test.ts"))})` }, content: [] }, ctx);
	const text = result.content.map((part) => part.text).join("\n");
	assert.match(text, /TESTING-RULE-BODY/);
	assert.doesNotMatch(text, /ALWAYS-RULE-BODY/);
	rmSync(link);
});

test("next to sieun-rules the entry follows a cell's os.chdir with sieun-rules' kernel-cwd, and alone it reads a cell in the session cwd", async () => {
	const here = join(import.meta.dirname, "..", "src", "pi");
	const found = await kernelCwd(here);
	assert.equal(found.cellSteps, cellSteps, "the package in this repo uses sieun-rules' kernel-cwd.ts");
	const alone = mkdtempSync(join(tmpdir(), "claude-rules-alone-"));
	try {
		assert.equal(await kernelCwd(join(alone, "src", "pi")), sessionCwd);
	} finally {
		rmSync(alone, { recursive: true, force: true });
	}
	assert.deepEqual(sessionCwd.cellSteps("os.chdir('apps')\nopen('x')", "/repo"), [{ code: "os.chdir('apps')\nopen('x')", cwd: "/repo" }]);
	assert.equal(sessionCwd.cellStart({ cwd: "/repo" }), "/repo");
});
