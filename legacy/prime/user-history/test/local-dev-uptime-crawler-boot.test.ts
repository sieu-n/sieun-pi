// Guards ops guy's d1 on 10-29: the local crawler restarted on alembic revision '0238_brand_lists', which no file held, and d1 only read it as not answering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureUptime, unknownRevisionLine, type UptimeDeps } from "../scripts/duties/local-dev-uptime.ts";

const FAILED = "2026-10-29 20:12:40,464 ERROR runtime.supervisor bootstrap failed: unknown alembic revision 0238_brand_lists: the database is at a revision no file in apps/crawler-v3/alembic/versions holds; commit that migration, or run its downgrade and alembic stamp the checkout's head";

function deps(log: string, calls: string[][]): UptimeDeps {
  return {
    fetch: (async (url: string) => new Response("down", { status: String(url).includes("8787") ? 502 : 200 })) as typeof fetch,
    now: () => Date.parse("2026-10-29T20:20:00Z"), platform: "linux", env: { CRAWLER_API_URL: "http://127.0.0.1:8787" },
    wiki: "https://us-metal02-dev.tail0c093d.ts.net:5176", pm2: { bin: "pm2", home: "/pm2" }, watch: async () => [], wait: async () => {},
    read: async path => { throw new Error(`ENOENT: ${path}`); },
    exec: async (file, args) => {
      if (file !== "docker") throw new Error(`spawn ${file} ENOENT`);
      calls.push([...args]);
      if (args[0] === "ps") return "auto-sns-agent-crawler-v3-1\n";
      if (args[0] === "inspect") return "2026-10-29T20:12:28.0Z\n";
      return log;
    },
  };
}

test("a down local crawler names the unknown alembic revision from its newest boot", async () => {
  const calls: string[][] = [];
  const { output } = await measureUptime(deps(`[bootstrap] alembic.util.exc.CommandError: Can't locate revision identified by '0238_brand_lists'\n${FAILED}\n`, calls), undefined);
  const boot = output.flagged?.find(slice => slice.kind === "crawler_boot");
  assert.match(boot?.excerpt ?? "", /^crawler: container auto-sns-agent-crawler-v3-1: bootstrap failed: unknown alembic revision 0238_brand_lists/);
  assert.deepEqual(calls.find(args => args[0] === "logs"), ["logs", "--since", "2026-10-29T20:12:28.0Z", "auto-sns-agent-crawler-v3-1"]);
});

test("a down crawler whose log holds no unknown revision adds no cause", async () => {
  const { output } = await measureUptime(deps("connection refused\n", []), undefined);
  assert.ok(!output.flagged?.some(slice => slice.kind === "crawler_boot"));
});

test("the newest unknown-revision line wins", () => {
  assert.equal(unknownRevisionLine(`${FAILED.replace("0238_brand_lists", "0230_old")}\n${FAILED}\n`)?.split(":")[1], " unknown alembic revision 0238_brand_lists");
  assert.equal(unknownRevisionLine("supervisor starting\n"), undefined);
});
