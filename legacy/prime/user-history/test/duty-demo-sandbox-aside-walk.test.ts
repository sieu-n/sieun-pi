// Guards d1's offline walk after owner c177 (10-27): "can you remove Headless browser???? NEVER put it back in. we'll always use Aside only."
// The walk moved from Playwright with a headless browser on us-metal02 to demo-sandbox-walk.ts, which drives the owner's Aside over `aside mcp`.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWalk, slowestPage } from "../scripts/duties/demo-sandbox.ts";
import { asideRepl, type Repl } from "../scripts/duties/aside-repl.ts";
import { BROWSER_URL, egressLines, MARK_OLD, MARKETING_TITLE, NEW_TEXT, REPL_LIB, runWalk, scenarioTitle, testErrors, walkRepl, walkReport } from "../scripts/duties/demo-sandbox-walk.ts";
import { BASE_URL } from "../scripts/duties/demo-sandbox.ts";

const clean = { outside: [], violations: [], failed: [] };

test("the walk's report reads in the precheck: outside requests, other failures and page timings", () => {
  const timing = { scenario: "kbeauty-brand", path: "/app/search", switches: [{ ms: 900, long_ms: 0, document: false }], loads: [{ ms: 2500, long_ms: 400 }] };
  const outside = "http://localhost:5180/app/search?world=x -> https://fonts.googleapis.com/css2?family=Inter";
  const report = walkReport(Date.parse("2026-10-27T02:00:00Z"), [
    { title: scenarioTitle("kbeauty-brand"), annotations: [{ type: "page-timing", description: JSON.stringify(timing) }],
      errors: testErrors([], 9, { ...clean, outside: [outside, outside] }, []) },
    { title: scenarioTitle("fresh-start"), annotations: [], errors: testErrors([{ path: "/app/inbox", step: "load", error: "still on /configure after 100000 ms" }], 9, clean, []) },
    { title: MARKETING_TITLE, annotations: [], errors: testErrors([], 4, { ...clean, violations: ["http://localhost:5180/: img-src blocked https://x.test/a.png"] }, []) },
  ]);
  const walk = readWalk(JSON.parse(JSON.stringify(report)));
  assert.equal(walk.at, Date.parse("2026-10-27T02:00:00Z"));
  assert.equal(walk.tests, 3);
  assert.deepEqual(walk.outside, [outside]);
  assert.equal(walk.otherFailures.length, 2);
  assert.match(walk.otherFailures[0]!, /^fresh-start: every browser and server request stays on localhost: failed: 1 of 9 pages failed$/);
  assert.match(walk.otherFailures[1]!, /: failed: CSP violations$/);
  assert.deepEqual(walk.untimed, [scenarioTitle("fresh-start")]);
  assert.equal(slowestPage(walk.pages, []).ms, 900);
});

// 10-27 22:50Z: the walk failed all 3 tests on 4 refusals another tab hit at 22:47Z, because the egress record holds the process's life.
test("a walk counts only the refused outside calls from its own start", () => {
  const entry = (at: string) => ({ at, kind: "fetch", target: "https://x.cdninstagram.com/a.jpg", reason: "demo egress blocked", world: "kbeauty-brand.a", stack: [] });
  const lines = egressLines([entry("2026-10-27T22:47:10.511Z"), entry("2026-10-27T22:51:21.000Z")], Date.parse("2026-10-27T22:50:16.431Z"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^2026-10-27T22:51:21\.000Z fetch https:\/\/x\.cdninstagram\.com\/a\.jpg: demo egress blocked \(world kbeauty-brand\.a; no app frame\)$/);
});

test("a clean test passes, and the first failed clean check ends the list as offline.spec.ts's expect did", () => {
  assert.deepEqual(testErrors([], 9, clean, []), []);
  const errors = testErrors([], 9, { outside: [], violations: ["a"], failed: ["500 script /x"] }, new Error("GET /__demo/egress gave HTTP 502"));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^CSP violations\n/);
  assert.deepEqual(testErrors([], 9, clean, new Error("fetch failed")), ["outside calls the dev server refused (GET /__demo/egress): fetch failed"]);
});

test("the walk's tabs use their own .localhost host on 5180's port, which the REPL side counts as local", () => {
  const browser = new URL(BROWSER_URL), base = new URL(BASE_URL);
  assert.notEqual(browser.hostname, base.hostname, "the owner's localhost:5180 tabs fill that host's six connections (10-27 22:16Z)");
  assert.match(browser.hostname, /\.localhost$/);
  assert.equal(browser.port, base.port);
  assert.match(REPL_LIB, /url\.hostname\.endsWith\("\.localhost"\)/);
});

test("the walk opens every page on BROWSER_URL", async () => {
  const opened: string[] = [];
  const world = `${BROWSER_URL}/app/campaigns/heartleaf-toner-us?view=home&world=kbeauty-brand.000000000000`;
  const answers: [RegExp, unknown][] = [
    [/^open a tab/, "tab"], [/^open /, { status: 200, url: BROWSER_URL }], [/^land on/, world], [/^time the load$/, { ms: 1, longMs: 0 }],
    [/^read the path$/, "/app"], [/^switch to /, { ms: 1, longMs: 0, document: false }], [/^close the tab$/, clean],
  ];
  const repl: Repl = {
    async call<T>(name: string, code: string): Promise<T> {
      const url = /__walk\.goto\("([^"]+)"\)/.exec(code)?.[1];
      if (url) opened.push(url);
      return (answers.find(([pattern]) => pattern.test(name))?.[1] ?? null) as T;
    },
    stop() {},
  };
  await runWalk(repl);
  assert.ok(opened.length > 20);
  assert.deepEqual(opened.filter(url => !url.startsWith(`${BROWSER_URL}/`)), []);
});

// 11-02 04:42Z: Aside's REPL lost its scope 3 min after the Mac booted, and every later call of the walk read "'__walk' is not defined".
test("a call that finds the walk gone defines it again, opens a new tab and runs once more", async () => {
  const titles: string[] = [];
  let defined = false;
  const repl = walkRepl({
    async call<T>(title: string, code: string): Promise<T> {
      titles.push(title);
      if (title === "define the walk") { defined = true; return "ok" as T; }
      if (!defined) throw new Error("Error: ReferenceError: '__walk' is not defined");
      if (code.includes("boom")) throw new Error("Error: boom");
      return title as T;
    },
    stop() {},
  });
  assert.equal(await repl.call<string>("time the load", "return await __walk.timeLoad(30000);"), "time the load");
  assert.deepEqual(titles, ["time the load", "define the walk", "new tab", "time the load"]);
  titles.length = 0;
  defined = false;
  await repl.call("open a tab for x", "return await __walk.open();");
  assert.deepEqual(titles, ["open a tab for x", "define the walk", "open a tab for x"]);
  await assert.rejects(repl.call("other", "boom"), /Error: boom/);
});

interface FakeNode { nodeType: number; textContent?: string; shown?: boolean; attrs?: Set<string>; childNodes?: FakeNode[] }
const el = (shown: boolean, ...childNodes: FakeNode[]): FakeNode => ({ nodeType: 1, shown, attrs: new Set(), childNodes });
const text = (value: string): FakeNode => ({ nodeType: 3, textContent: value });
const page = (node: FakeNode): unknown => node.nodeType === 3 ? node : {
  nodeType: 1,
  checkVisibility: () => node.shown,
  setAttribute: (name: string) => node.attrs!.add(name),
  hasAttribute: (name: string) => node.attrs!.has(name),
  get childNodes() { return node.childNodes!.map(page); },
  get children() { return node.childNodes!.filter(child => child.nodeType === 1).map(page); },
};

test("a kept view that a switch shows again counts as shown, while the view on screen at the click stays old", () => {
  const newText = new Function(`return ${NEW_TEXT}`)() as (element: unknown) => boolean;
  const markOld = new Function(`return ${MARK_OLD}`)() as (element: unknown) => void;
  const dashboards = el(true, el(true, text("Updated 22s ago")));
  const campaigns = el(false, el(true, text("Campaigns")));
  const main = el(true, dashboards, campaigns);
  for (const child of main.childNodes!) markOld(page(child));
  assert.equal(newText(page(main)), false);
  dashboards.shown = false;
  assert.equal(newText(page(main)), false);
  campaigns.shown = true;
  assert.equal(newText(page(main)), true);
  assert.ok(REPL_LIB.includes(NEW_TEXT) && REPL_LIB.includes(MARK_OLD));
});

test("the REPL side of the walk is valid JavaScript with no TypeScript left in it", () => {
  assert.doesNotThrow(() => new Function(`return (async () => { ${REPL_LIB} })`));
});

test("asideRepl keeps one aside mcp process, returns each call's value and raises a REPL error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aside-walk-"));
  const fake = join(dir, "aside");
  writeFileSync(fake, `#!/usr/bin/env node
let calls = 0, buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (message.id === undefined) continue;
    const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") answer({ serverInfo: { name: "fake-aside" } });
    else if (message.arguments?.code?.includes("boom") || message.params.arguments.code.includes("boom")) answer({ isError: true, content: [{ type: "text", text: "Error: boom" }] });
    else answer({ content: [{ type: "text", text: "noise\\nWALK_RESULT " + JSON.stringify({ calls: ++calls, pid: process.pid }) }] });
  }
});
`);
  chmodSync(fake, 0o755);
  const repl = asideRepl(fake);
  try {
    const first = await repl.call<{ calls: number; pid: number }>("one", "return 1;");
    const second = await repl.call<{ calls: number; pid: number }>("two", "return 2;");
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 2);
    assert.equal(first.pid, second.pid, "one process for the whole walk, so the REPL scope survives between calls");
    await assert.rejects(repl.call("three", "boom"), /Error: boom/);
  } finally { repl.stop(); }
});
