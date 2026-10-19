// On 10-19 a raw `node --import tsx --test --test-timeout=60000 test/relink-lost-link.test.ts` sat 85 min with no output after its 2 tests
// passed in 4 s, because --test-timeout does not end a file that leaves a socket, timer or child open, and d7 counted it as a hung call.
// Every node --test script of this package passes --test-force-exit, so a leaked handle ends the run once its tests finish.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every node --test script passes --test-force-exit, so a file that leaks a handle cannot hold the run open", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const runs = Object.entries(scripts).filter(([, command]) => /\bnode\b.*--test\b/.test(command));
  assert.ok(runs.length >= 2, "the test and test:one scripts run node --test");
  for (const [name, command] of runs) assert.match(command, /--test-force-exit/, `${name} runs node --test without --test-force-exit`);
});
