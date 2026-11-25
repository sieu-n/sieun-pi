/**
 * The docs-current duty precheck (scripts/duties/docs-current.ts): a page is current when its last_verified is at or after the newest commit
 * to the code its meta lists, a page with no list is counted apart with the files it cites, and a page that is not current is skipped.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/docs-current.test.ts
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { codeToolArgs, docsCurrent, pageArgs, readPage, SPACE } from "../../scripts/duties/docs-current.ts";

const page = (meta: object, body = "") => `<!--wiki\n${JSON.stringify(meta)}\n-->\n<h1>t</h1>${body}`;
const exists = (file: string) => file !== "apps/chat/server/gone.ts";
const at = (iso: string) => Date.parse(iso);

test("a page reads its code list from its meta, or else the repo files its text cites, and a superseded page is skipped", () => {
  const listed = readPage(`${SPACE}/reference/a.html`, page({ status: "current", last_verified: "2026-11-25T10:00Z", code: ["packages/pi-host/src/durable/room-tools.ts"] }, "<code>apps/chat/server/app.ts:12</code>"), exists)!;
  assert.deepEqual(listed, { path: `${SPACE}/reference/a.html`, lastVerified: at("2026-11-25T10:00Z"), code: ["packages/pi-host/src/durable/room-tools.ts"], declared: true });
  const cited = readPage(`${SPACE}/how-to/b.html`, page({ last_verified: "2026-11-25T10:00Z" }, "see apps/chat/server/app.ts:12 and apps/chat/server/gone.ts"), exists)!;
  assert.deepEqual(cited.code, ["apps/chat/server/app.ts"]);
  assert.equal(cited.declared, false);
  assert.equal(readPage(`${SPACE}/reference/c.html`, page({ status: "superseded" }), exists), undefined);
});

test("a page with a code list is stale once a commit to that code is newer than its last_verified, and one with no list is counted apart", () => {
  const ref = (name: string, verified: string) => ({ path: `${SPACE}/reference/${name}.html`, lastVerified: at(verified), code: ["x.ts"], declared: true });
  const change = (iso: string) => ({ at: at(iso), sha: "590b9abc45f9", subject: "feat: a change" });
  const out = docsCurrent([
    { page: ref("fresh", "2026-11-25T12:00Z"), change: change("2026-11-25T11:00Z") },
    { page: ref("stale", "2026-11-24T12:00Z"), change: change("2026-11-25T11:00Z") },
    { page: ref("untouched", "2026-11-20T12:00Z"), change: undefined },
    { page: { path: `${SPACE}/how-to/loose.html`, lastVerified: at("2026-11-25T12:00Z"), code: ["apps/chat/server/app.ts"], declared: false }, change: undefined },
  ]);
  assert.deepEqual(out.metrics, { reference_current_pct: 66.7, stale_pages: 1, pages_without_code: 1, args_mismatch: 0, args_tools_checked: 0, reference_pages_checked: 3, pages_checked: 4 });
  assert.deepEqual(out.flagged.map(f => f.kind), ["stale_page", "no_code"]);
  assert.match(out.flagged[0]!.excerpt, /reference\/stale\.html \(last_verified 2026-11-24T12:00Z\) is older than 590b9abc "feat: a change"/);
  assert.match(out.flagged[1]!.excerpt, /its text cites apps\/chat\/server\/app\.ts$/);
});

const argsTable = (rows: string) => `<table>\n<thead><tr><th>Tool</th><th>Args</th><th>Code</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
/** The search_messages row of the comm tools page (reference/comm-tools.html) as it read on 11-25, which left out `where`. */
const SEARCH_ROW = '<tr><td><code>search_messages</code></td><td><code>query</code>, <code>from?</code>, <code>place?</code>, <code>in?</code>, <code>after?</code>, <code>before?</code>, <code>sort?</code>, <code>limit?</code> number, <code>cursor?</code>, <code>full?</code> boolean</td><td><code>search-messages.ts</code></td></tr>';

test("an Args table's rows give each tool's args, with ? for an optional one, and a page with no such table has none", () => {
  const html = page({}, `${argsTable(`<tr><td><code>remind_me</code></td><td><code>message_id</code>, <code>in_minutes?</code> number or <code>at?</code> ISO time</td><td><code>later.ts</code></td></tr>
<tr><td><code>stop_work</code></td><td>none</td><td><code>comm.ts</code></td></tr>`)}<table><thead><tr><th>Waste</th><th>Count</th></tr></thead><tbody><tr><td><code>x</code></td><td><code>y</code></td></tr></tbody></table>`);
  assert.deepEqual(pageArgs(html), { remind_me: { message_id: true, in_minutes: false, at: false }, stop_work: {} });
  assert.equal(pageArgs(page({}, "<p>no table</p>")), undefined);
  assert.deepEqual(readPage(`${SPACE}/reference/t.html`, html, exists)!.args, pageArgs(html));
});

test("an Args row that leaves out an arg, names one the code lacks or marks one wrongly optional is an args_mismatch, and an unknown tool is not checked", () => {
  const listed = readPage(`${SPACE}/reference/t.html`, page({ status: "current", code: ["x.ts"] }, argsTable(`<tr><td><code>remind_me</code></td><td><code>message_id?</code>, <code>at?</code>, <code>when?</code></td><td></td></tr>
<tr><td><code>ipython</code></td><td><code>code</code></td><td></td></tr>`)), exists)!;
  const out = docsCurrent([{ page: listed, change: undefined }], { remind_me: { message_id: true, in_minutes: false, at: false } });
  assert.equal(out.metrics.args_mismatch, 3);
  assert.equal(out.metrics.args_tools_checked, 1);
  assert.deepEqual(out.flagged.map(f => f.excerpt), [
    `The Args row for remind_me on ${SPACE}/reference/t.html marks \`message_id\` optional, and the code makes it required.`,
    `The Args row for remind_me on ${SPACE}/reference/t.html leaves out \`in_minutes\`, which the code defines.`,
    `The Args row for remind_me on ${SPACE}/reference/t.html names \`when\`, which the code does not define.`,
  ]);
});

test("the comm tools page's search_messages row of 11-25 matches the args the code defines", () => {
  const repo = process.env.SPEC_CLEAN_REPO ?? resolve(import.meta.dirname, "../../../..");
  // The checkout's own code, without the module hook a spec-clean run puts in NODE_OPTIONS.
  const tools = codeToolArgs(repo, { ...process.env, NODE_OPTIONS: "" });
  assert.ok(tools.search_messages, "the code defines search_messages");
  const listed = readPage(`${SPACE}/reference/comm-tools.html`, page({ status: "current", code: ["x.ts"] }, argsTable(SEARCH_ROW)), exists)!;
  assert.deepEqual(docsCurrent([{ page: listed, change: undefined }], tools).flagged.map(f => f.excerpt), []);
});
