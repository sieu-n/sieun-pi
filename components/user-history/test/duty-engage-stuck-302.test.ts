// Guards d1's engage_accounts_stuck against redirects that are about the page. On 2026-10-22 prod account 201 read as stuck on 4 story reads
// that Instagram sent to /stories/instagram/?r=1, a redirect that 9 of the 18 accounts it hit served pages after, while classify.verdict parks
// a jar only on the login page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STUCK_302S, lostSession, stuckOf } from "../scripts/duties/engage-reads.ts";

const AT = Date.parse("2026-10-22T02:43:00Z");
const row = (id: number, reason: string, location: string, count: number) => `active_redirects\t${id}\t${AT}\t${reason}\t${location}\t${count}\n`;

test("the story page's own redirect does not make an active account stuck", () => {
  assert.deepEqual(stuckOf(row(201, "http_302 redirected", "https://www.instagram.com/stories/instagram/?r=1", 4)), []);
});

test("redirects to the login page, a challenge, or no Location count as a lost session", () => {
  assert.ok(lostSession("http_302 redirected", "https://www.instagram.com/accounts/login/?next=%2Fexplore%2F"));
  assert.ok(lostSession("http_302 redirected", "/challenge/AXH/"));
  assert.ok(lostSession("http_302 unknown_upstream", ""));
  assert.ok(lostSession("http_302 jar_login_redirect", "https://www.instagram.com/"));
  assert.ok(!lostSession("http_302 redirected", "https://www.instagram.com/stories/instagram/?r=1"));
});

test("an active account with enough login-page redirects is stuck, summed over its rows, and the story rows do not add to it", () => {
  const tsv = row(16, "http_302 redirected", "https://www.instagram.com/accounts/login/", STUCK_302S - 1) + row(16, "http_302 jar_login_redirect", "https://www.instagram.com/accounts/login/?next=/", 1)
    + row(201, "http_302 redirected", "https://www.instagram.com/accounts/login/", STUCK_302S - 1) + row(201, "http_302 redirected", "https://www.instagram.com/stories/instagram/?r=1", 4)
    + `frozen_shared_exit\t7\t${AT}\t\t\t0\n`;
  assert.deepEqual(stuckOf(tsv), [{ kind: "frozen_shared_exit", accountId: 7, since: AT }, { kind: "active_302s", accountId: 16, since: AT }]);
});

test("stuckOf refuses a line it does not know", () => {
  assert.throws(() => stuckOf(`active_302s\t16\t${AT}\t\t\t0\n`), /unexpected line/);
  assert.throws(() => stuckOf(`active_redirects\t16\t${AT}\thttp_302 redirected\n`), /unexpected line/);
});
