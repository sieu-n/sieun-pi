// Owner c177, 10-27, on Settings > Tools and skills showing a "Headless browser" row: "can you remove Headless browser???? NEVER put it back in.
// we'll always use Aside only." These fail if a headless browser comes back as a host tool, a Skills and tools check, a pane row, or a harness
// launch anywhere in the repo; the repo scan is the pre-commit hook's own (scripts/git-hooks/no-headless.mjs), which skips test code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKS } from "../scripts/duties/skills-and-tools.ts";
import { HOST_TOOLS, parseHosts } from "../src/hosts.ts";
// @ts-expect-error: a plain .mjs hook with no types
import { headlessLaunches, inScope } from "../../../../scripts/git-hooks/no-headless.mjs";

const REPO = join(import.meta.dirname, "../../../..");
const HEADLESS = /headless|chromium|chrome for testing|box[_ -]?browser/i;

test("no host tool, Skills and tools check or Settings pane row is a headless browser", () => {
  assert.deepEqual(HOST_TOOLS.filter(tool => HEADLESS.test(tool)), []);
  assert.deepEqual(CHECKS.filter(check => HEADLESS.test(`${check.id} ${check.tool} ${check.hostTool ?? ""}`)).map(check => check.id), []);
  const pane = readFileSync(join(import.meta.dirname, "../src/client/ToolsSettings.svelte"), "utf8");
  assert.deepEqual(pane.split("\n").filter(line => /headless/i.test(line)), []);
  const server = readFileSync(join(import.meta.dirname, "../src/chat-tools.ts"), "utf8");
  assert.doesNotMatch(server, /box_browser|headless/i);
  assert.throws(() => parseHosts({ version: 1, hosts: [{ name: "box", hostname: "box", address: "100.0.0.1", relayPort: 7790, token: "file:t",
    daemonSocket: "/tmp/d.sock", ssh: null, roles: {}, tools: ["headless-browser"] }] }), /tools: needs a list of/);
});

/** The tracked files, or every file under the scanned roots in a release build's export, which has no .git. */
function repoFiles(): string[] {
  if (existsSync(join(REPO, ".git"))) return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0");
  return ["skills", "components", "scripts", "config", "deploy"].filter(root => existsSync(join(REPO, root)))
    .flatMap(root => readdirSync(join(REPO, root), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(REPO.length + 1)));
}

test("no skill, component, script, config or deploy file launches a headless browser", () => {
  const files = repoFiles().filter(path => inScope(path) && existsSync(join(REPO, path)));
  assert.ok(files.length > 20, `only ${files.length} files in scope`);
  assert.deepEqual(files.flatMap((path: string) => headlessLaunches(path, readFileSync(join(REPO, path), "utf8"))), []);
});

test("the scan catches each way a headless browser starts and leaves product tests, detectors and headful Chrome alone", () => {
  const caught = (path: string, text: string) => headlessLaunches(path, text).length > 0;
  assert.ok(caught("skills/x/run.mjs", "const b = await chromium.launch();"));
  assert.ok(caught("skills/x/run.mjs", "await chromium.launch({ headless: true })"));
  assert.ok(caught("components/x/shot.ts", "spawn(chrome, [\"--headless=new\", url])"));
  assert.ok(caught("skills/x/shot.py", "browser = p.chromium.launch(headless=True)"));
  assert.ok(caught("scripts/shot.sh", "npx playwright screenshot http://localhost:5180 out.png"));
  assert.ok(caught("skills/x/SKILL.md", "Run `google-chrome --headless --screenshot` on the page."));
  assert.ok(!caught("skills/aside-browser/box/box.mjs", "await chromium.launch({ headless: false, executablePath: chrome, env })"));
  assert.ok(!caught("legacy/prime/user-history/test/devtools-pipe.ts", "spawn(binary, [\"--headless=new\"])"));
  assert.ok(!caught("components/x/scripts/ps.ts", "/chrom/i.test(cmd) && /\\s--headless(?:[=\\s]|$)/.test(cmd)"));
  assert.ok(!caught("skills/x/SKILL.md", "d7 counts every chrome-headless-shell on the Mac."));
});
