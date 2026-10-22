// d2 walked the owner org's watch keys about 65 times a day per env on 10-19 to 10-21, 20,000 to 24,000 Convex rows a walk, while the keys
// had not changed for 9 days. These cases pin that convexKeys walks pageKeys only when the org's watch-key stamp moved.
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convexKeys } from "../scripts/duties/watchlist-green.ts";

/** A fake of the Convex authorize route and /api/query: two pages of keys, and the stamp query when `stamp` is set. */
function fakeConvex(state: { stamp: string | null; keys: string[] }) {
  const calls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("authorize_within_current_project")) return json({ adminKey: "ak", url: "https://dep.convex.cloud" });
    const { path, args } = JSON.parse(String(init.body)) as { path: string; args: { cursor?: string | null } };
    calls.push(path);
    if (path === "search/watchTargets:watchKeysStamp") {
      return state.stamp === null ? json({ status: "error", errorMessage: "Could not find public function" }) : json({ status: "success", value: state.stamp });
    }
    const half = Math.ceil(state.keys.length / 2);
    const first = args.cursor === null;
    return json({ status: "success", value: { keys: first ? state.keys.slice(0, half) : state.keys.slice(half), continueCursor: "c1", isDone: !first } });
  }) as typeof fetch;
  return { fetcher, calls, walks: () => calls.filter(path => path.endsWith(":pageKeys")).length };
}

test("convexKeys walks once per stamp and answers the kept keys while the stamp holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-keys-"));
  const state = { stamp: "q:3:a:b" as string | null, keys: ["instagram:account:nike", "instagram:tagged:nike", "instagram:account:puma"] };
  const convex = fakeConvex(state);
  const read = () => convexKeys(convex.fetcher, "token", AbortSignal.timeout(5000), "dep", "org_x", dir);
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 2);
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 2, "an unchanged stamp walks nothing");
  state.stamp = "q:4:a:c";
  state.keys = ["instagram:account:nike", "instagram:account:puma", "instagram:account:adidas"];
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 4, "a moved stamp walks again");
  assert.deepEqual(await readdir(dir), ["dep-org_x.json"]);
});

test("a deployment without the stamp query walks every time and keeps nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-keys-"));
  const convex = fakeConvex({ stamp: null, keys: ["instagram:account:nike"] });
  const read = () => convexKeys(convex.fetcher, "token", AbortSignal.timeout(5000), "dep", "org_x", dir);
  assert.deepEqual(await read(), ["instagram:account:nike"]);
  assert.deepEqual(await read(), ["instagram:account:nike"]);
  assert.equal(convex.walks(), 4);
  assert.deepEqual(await readdir(dir), []);
});
