import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Mac browser guard (packages/sieun-rules/src/browser.ts), owner c177 and c103. On 10-28 at 02:18:31Z the 'staging timings' job ran
// `cd /tmp/timings-mac && RUNS=1 node scout.mjs` through the kernel's bash() on the owner's Mac, and scout.mjs's chromium.launch started
// Chrome for Testing pid 9679. These commands are only fed to the handlers; nothing here runs them or starts a browser.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-browser-")));
const saved = { log: process.env.GLOBAL_RULES_LOG, platform: process.env.GLOBAL_RULES_PLATFORM };
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  for (const [key, name] of [["log", "GLOBAL_RULES_LOG"], ["platform", "GLOBAL_RULES_PLATFORM"]]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const timings = join(root, "timings-mac");
mkdirSync(join(timings, "lib"), { recursive: true });
writeFileSync(join(timings, "scout.mjs"), [
  'import { chromium } from "playwright";',
  "const runs = Number(process.env.RUNS ?? 1);",
  "const browser = await chromium.launch({ headless: true });",
  "await browser.close();",
].join("\n"));
writeFileSync(join(timings, "lib", "browser.ts"), 'import puppeteer from "puppeteer";\nexport const open = () => puppeteer.launch();\n');
writeFileSync(join(timings, "via-helper.mjs"), 'import { open } from "./lib/browser.js";\nawait open();\n');
writeFileSync(join(timings, "scout.py"), "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n    p.chromium.launch()\n");
writeFileSync(join(timings, "aside.mjs"), 'import { chromium } from "playwright";\nconst b = await chromium.connectOverCDP("http://127.0.0.1:9222");\n');
writeFileSync(join(timings, "plain.mjs"), "console.log(await fetch('http://localhost:5180').then((r) => r.status));\n");
writeFileSync(join(timings, "package.json"), JSON.stringify({ scripts: { "test:e2e": "playwright test", build: "tsc -p ." } }));

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });
const cell = (command) => `r = await bash(${JSON.stringify(command)})\nprint(r.output)`;

function refused(toolName, texts) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /browser guard/, `${toolName}: ${text}`);
    assert.match(result.reason, /aside_browser/);
    assert.match(result.reason, /us-metal02/);
  }
}

function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

test("on the Mac, the 10-28 scout.mjs run through the kernel's bash() is refused, and so are the other launch forms", () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  refused("ipython", [
    cell(`cd ${timings} && RUNS=1 node scout.mjs`),
    cell(`cd ${timings} && nohup sh -c 'for i in 1 2 3; do RUNS=10 node scout.mjs; done' > /tmp/runs.log 2>&1 &`),
  ]);
  refused("bash", [
    `cd ${timings} && RUNS=1 node scout.mjs`,
    `node ${join(timings, "via-helper.mjs")}`,
    `cd ${timings} && python3 scout.py`,
    `cd ${timings} && uv run scout.py`,
    `node -e 'const { chromium } = require("playwright"); chromium.launch()'`,
    `cd ${timings} && npx playwright test tests/offline.spec.ts`,
    `cd ${timings} && pnpm exec playwright screenshot http://localhost:5180 shot.png`,
    `cd ${timings} && npm run test:e2e`,
    `cd ${timings} && pnpm playwright codegen`,
    `python3 -m playwright open http://localhost:5180`,
  ]);
});

test("on the Mac, scripts that start no browser and text that only names a launch pass", () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  allowed("bash", [
    `cd ${timings} && node plain.mjs`,
    `cd ${timings} && node aside.mjs`,
    `cd ${timings} && npm run build`,
    `rg -n 'chromium.launch' ${timings}`,
    `cat ${join(timings, "scout.mjs")}`,
    "npx playwright install chromium",
    "git commit -m 'docs: never chromium.launch on the Mac' -- README.md",
  ]);
});

test("on us-metal02 and in CI the same commands pass (c163)", () => {
  process.env.GLOBAL_RULES_PLATFORM = "linux";
  allowed("ipython", [cell(`cd ${timings} && RUNS=1 node scout.mjs`)]);
  allowed("bash", [`cd ${timings} && npx playwright test`, `node ${join(timings, "via-helper.mjs")}`]);
});

test("the kernel half refuses a launch whose command the cell builds at run time", () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  const result = sendCheck.judgeCheck({ kind: "shell", text: "RUNS=10 node scout.mjs", cwd: timings });
  assert.equal(result.block, true);
  assert.match(result.reason, /browser guard/);
  assert.deepEqual(sendCheck.judgeCheck({ kind: "shell", text: "node plain.mjs", cwd: timings }), { block: false });
  process.env.GLOBAL_RULES_PLATFORM = "linux";
  assert.deepEqual(sendCheck.judgeCheck({ kind: "shell", text: "RUNS=10 node scout.mjs", cwd: timings }), { block: false });
});
