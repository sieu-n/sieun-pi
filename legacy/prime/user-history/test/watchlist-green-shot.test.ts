// Guards d2's Watchlist screenshot (11-04): the shot signs a box Chrome in by Clerk ticket as the owner org's test admin, never the owner's Aside.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENVS, SHOT_EMAIL, shotProblem, signInTicket } from "../scripts/duties/watchlist-green-shot.ts";

const fakeClerk = (orgs: string[]) => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const path = new URL(url).pathname;
    const body = path === "/v1/users" ? [{ id: "user_1" }]
      : path.endsWith("/organization_memberships") ? { data: orgs.map(id => ({ organization: { id } })) }
      : { id: "sit_1", token: "tok" };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetcher };
};

test("a ticket is minted only for the test admin of the org the shot reads", async () => {
  const member = fakeClerk([ENVS.prod.orgId]);
  assert.deepEqual(await signInTicket(member.fetcher, "sk", ENVS.prod.orgId), { id: "sit_1", token: "tok", userId: "user_1" });
  assert.match(member.calls[0]!, new RegExp(encodeURIComponent(SHOT_EMAIL)));
  const outsider = fakeClerk(["org_other"]);
  await assert.rejects(signInTicket(outsider.fetcher, "sk", ENVS.prod.orgId), /is not a member/);
  assert.ok(!outsider.calls.some(call => call.includes("sign_in_tokens")));
});

test("the shot counts only when it shows the owner org's Watchlist with a green chip", () => {
  const read = { url: "https://virev.ai/app/watchlist", orgId: ENVS.prod.orgId, tones: { tracking: 23, stopped: 3 }, notGreen: [] };
  assert.equal(shotProblem(read, ENVS.prod), null);
  assert.match(shotProblem({ ...read, url: "https://virev.ai/sign-in" }, ENVS.prod)!, /not \/app\/watchlist/);
  assert.match(shotProblem({ ...read, orgId: "org_other" }, ENVS.prod)!, /not org_3Irto/);
  assert.match(shotProblem({ ...read, tones: { loading: 30 } }, ENVS.prod)!, /no row shows the green/);
});
