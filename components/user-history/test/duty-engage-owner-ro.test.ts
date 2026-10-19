// Guards d1's prod reads against owner_ro's CONNECTION LIMIT 3. On 2026-10-19 at 15:20:31Z the three prod reads ran side by side next to a
// job's session and two of them failed with "too many connections for role owner_ro".
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/engage-reads.ts";

test("the prod owner_ro reads never overlap, and a failed one does not stop the next", async () => {
  let open = 0;
  let peak = 0;
  const prodRead = (answer: string | Error) => async (): Promise<string> => {
    open += 1;
    peak = Math.max(peak, open);
    await new Promise(resolve => setTimeout(resolve, 5));
    open -= 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const data = await measure(null, "no Grafana login", Date.now(), prodRead(new Error("too many connections for role owner_ro")),
    async () => "0\t0\n", prodRead("0\t0\t0\n"), prodRead(""));
  assert.equal(peak, 1);
  assert.deepEqual(data.lapsed, { waiting: 0, blocked: 0, oldestAt: null });
  assert.deepEqual(data.stuck, []);
  assert.ok(data.errors.some(error => error.source === "prod deep walks"));
});
