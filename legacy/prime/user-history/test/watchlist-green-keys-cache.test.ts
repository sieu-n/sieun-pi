// d2 walked the owner org's watch keys about 65 times a day per env on 10-19 to 10-21, 20,000 to 24,000 Convex rows a walk, while the keys
// had not changed for 9 days. These cases pin that convexKeys walks pageKeys only when the org's watch-key stamp moved, and that it never
// calls the stamp query on a deployment that does not serve it, because each such call pages ops through search-convex-call-refused.
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convexBackend } from "../scripts/duties/convex-admin.ts";
import { convexKeys } from "../scripts/duties/watchlist-green.ts";

/** A fake of a Convex backend's /instance_name and /api/query: two pages of keys, and the stamp query, listed in apiSpec, when `stamp` is set. */
function fakeConvex(state: { stamp: string | null; keys: string[] }) {
  const calls: string[] = [];
  const urls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    urls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/instance_name")) return new Response(url.startsWith("https://convex.virev.ai/") ? "convex-prod" : "dep");
    const { path, args } = JSON.parse(String(init.body)) as { path: string; args: { cursor?: string | null } };
    calls.push(path);
    if (path === "_system/cli/modules:apiSpec") {
      const listed = state.stamp === null ? [] : [{ identifier: "search/watchTargets.js:watchKeysStamp", functionType: "Query" }];
      return json({ status: "success", value: [{ identifier: "search/watchTargets.js:pageKeys", functionType: "Query" }, ...listed] });
    }
    if (path === "search/watchTargets:watchKeysStamp") {
      return state.stamp === null ? json({ status: "error", errorMessage: "Could not find public function" }) : json({ status: "success", value: state.stamp });
    }
    const half = Math.ceil(state.keys.length / 2);
    const first = args.cursor === null;
    return json({ status: "success", value: { keys: first ? state.keys.slice(0, half) : state.keys.slice(half), continueCursor: "c1", isDone: !first } });
  }) as typeof fetch;
  return { fetcher, calls, urls, walks: () => calls.filter(path => path.endsWith(":pageKeys")).length };
}

const DEP = { url: "https://dep.convex.cloud", instance: "dep", adminKey: "prod:dep|ak" };

test("convexKeys walks once per stamp and answers the kept keys while the stamp holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-keys-"));
  const state = { stamp: "q:3:a:b" as string | null, keys: ["instagram:account:nike", "instagram:tagged:nike", "instagram:account:puma"] };
  const convex = fakeConvex(state);
  const read = () => convexKeys(convex.fetcher, DEP, AbortSignal.timeout(5000), "org_x", dir);
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 2);
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 2, "an unchanged stamp walks nothing");
  state.stamp = "q:4:a:c";
  state.keys = ["instagram:account:nike", "instagram:account:puma", "instagram:account:adidas"];
  assert.deepEqual(await read(), state.keys);
  assert.equal(convex.walks(), 4, "a moved stamp walks again");
  assert.deepEqual(await readdir(dir), ["dep-org_x.json"]);
  assert.equal(convex.calls.filter(path => path.endsWith(":apiSpec")).length, 1, "a deployment with a kept stamp skips the function list");
});

test("a deployment without the stamp query walks every time and keeps nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-keys-"));
  const convex = fakeConvex({ stamp: null, keys: ["instagram:account:nike"] });
  const read = () => convexKeys(convex.fetcher, DEP, AbortSignal.timeout(5000), "org_x", dir);
  assert.deepEqual(await read(), ["instagram:account:nike"]);
  assert.deepEqual(await read(), ["instagram:account:nike"]);
  assert.equal(convex.walks(), 4);
  assert.deepEqual(await readdir(dir), []);
  assert.ok(!convex.calls.includes("search/watchTargets:watchKeysStamp"), "a deployment without the stamp query is never asked for it");
});

test("the keys come from the backend the VITE_CONVEX_URL row on origin/main names, with that instance's admin key (prod cutover 11-04)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-keys-"));
  const convex = fakeConvex({ stamp: null, keys: ["instagram:account:nike"] });
  const rows: Record<string, string> = { "origin/main:apps/api-portal/.env VITE_CONVEX_URL": "https://convex.virev.ai",
    "apps/api-portal/.env VITE_CONVEX_URL": "https://dev-tree-ahead-of-prod.example",
    "apps/ci/.env": JSON.stringify({ CONVEX_DEPLOY_KEY: "prod:befitting-sparrow-356|old", CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-prod|new" }) };
  const backend = await convexBackend("production", convex.fetcher,
    async (file, name, ref) => rows[`${ref ? `${ref}:` : ""}${file}${name ? ` ${name}` : ""}`]!);
  assert.deepEqual(backend, { url: "https://convex.virev.ai", instance: "convex-prod", adminKey: "convex-prod|new" });
  assert.deepEqual(await convexKeys(convex.fetcher, backend, AbortSignal.timeout(5000), "org_x", dir), ["instagram:account:nike"]);
  assert.ok(convex.urls.every(url => url.startsWith("https://convex.virev.ai/")), convex.urls.join(" "));
});
