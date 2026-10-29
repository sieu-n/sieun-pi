// Guards ops guy's d1 on 10-29: a take-in deleted a module an uncommitted edit still imported, and :5174 answered a bare "Internal Error".
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureUptime, newestErrorLine, type UptimeDeps } from "../scripts/duties/local-dev-uptime.ts";

const IMPORTER = "/repo/apps/search/src/lib/server/org-access.ts";
const MISSING = `2026-10-29T20:50:02: Error: Cannot find module '$lib/org-access-claim' imported from '${IMPORTER}'`;
const LOG = `2026-10-29T20:40:00: Error: older failure\n${MISSING}\n2026-10-29T20:50:02:     at fetchModule (file:///repo/node_modules/vite/dist/node/chunks/node.js:36152:32)\n2026-10-29T20:50:02:   runnerError: Error: RunnerError\n`;

function deps(log: string, gitStatus: string, calls: string[][]): UptimeDeps {
  return {
    fetch: (async (url: string) => String(url).includes("5174") ? new Response('{"message":"Internal Error"}', { status: 500 }) : new Response("ok")) as typeof fetch,
    now: () => Date.parse("2026-10-29T20:51:00Z"), platform: "linux", env: {},
    wiki: "https://us-metal02-dev.tail0c093d.ts.net:5176", pm2: { bin: "pm2", home: "/pm2" }, watch: async () => [], wait: async () => {},
    read: async path => { if (path === "/pm2/logs/search-error.log") return log; throw new Error(`ENOENT: ${path}`); },
    exec: async (file, args) => {
      if (file !== "git") throw new Error(`spawn ${file} ENOENT`);
      calls.push([...args]);
      return gitStatus;
    },
  };
}

test("a 5xx search app names its newest error and the importer's uncommitted edit", async () => {
  const calls: string[][] = [];
  const { output } = await measureUptime(deps(LOG, " M apps/search/src/lib/server/org-access.ts\n", calls), undefined);
  const cause = output.flagged?.find(slice => slice.kind === "dev_error");
  assert.equal(cause?.excerpt, `search: ${MISSING}; importer has uncommitted work (git status ' M')`);
  assert.deepEqual(calls[0], ["-C", "/repo/apps/search/src/lib/server", "status", "--porcelain", "--", IMPORTER]);
});

test("an importer that matches HEAD says so", async () => {
  const { output } = await measureUptime(deps(LOG, "", []), undefined);
  assert.match(output.flagged?.find(slice => slice.kind === "dev_error")?.excerpt ?? "", /; importer matches HEAD$/);
});

test("the stack and runnerError lines are not the newest error", () => {
  assert.equal(newestErrorLine(LOG), MISSING);
  assert.equal(newestErrorLine("2026-10-29T20:50:02: ready in 900 ms\n"), undefined);
});
