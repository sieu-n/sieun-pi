/**
 * The docs-current duty precheck (scripts/duties/docs-current.ts): a page is current when its last_verified is at or after the newest commit
 * to the code its meta lists, a page with no list is counted apart with the files it cites, and a page that is not current is skipped.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/docs-current.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { docsCurrent, readPage, SPACE } from "../../scripts/duties/docs-current.ts";

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
  assert.deepEqual(out.metrics, { reference_current_pct: 66.7, stale_pages: 1, pages_without_code: 1, reference_pages_checked: 3, pages_checked: 4 });
  assert.deepEqual(out.flagged.map(f => f.kind), ["stale_page", "no_code"]);
  assert.match(out.flagged[0]!.excerpt, /reference\/stale\.html \(last_verified 2026-11-24T12:00Z\) is older than 590b9abc "feat: a change"/);
  assert.match(out.flagged[1]!.excerpt, /its text cites apps\/chat\/server\/app\.ts$/);
});
