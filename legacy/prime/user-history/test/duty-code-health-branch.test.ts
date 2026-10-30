// Guards owner rule c119: us-metal02 moved from sieun/dev to dev/sieun on 2026-10-27 08:17Z, so the code health report reads its page module
// and the CI plan's junit suite table from dev/sieun. The suite table sets the expected suites (owner, 2026-10-15: "now the same system will
// monitor and report test stats, CI stats."), so a suite that stops printing stays missing until the plan drops it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_MODULE_REF, SUITES_MODULE, TRACKED, measure, planSuites, rankedGaps, type StoreDay } from "../scripts/duties/code-health-report.ts";

const day = (suites: string[]): StoreDay => ({ repos: ["auto-sns-agent", "sieun-pi"], backfilled: [], rows: [], hotspots: [], suites, ciRows: 1 });
const testsGaps = (suites: string[], expected: string[] | null): string[] =>
  rankedGaps([], [], day(suites), expected).find(metric => metric.name === "tests (full suite set)")!.gaps;

test("the code health report reads the page module and the suite table from dev/sieun", () => {
  assert.equal(PAGE_MODULE_REF, "origin/dev/sieun");
  assert.equal(SUITES_MODULE, "scripts/ci/junit-suites.mjs");
  assert.equal(TRACKED.filter(metric => metric.check === "suites").length, 1);
});

test("a suite the plan expects that the day's load lacks is a gap, and a suite the plan dropped is not", () => {
  const gaps = testsGaps(["checks-guards", "pytest-seo"], ["checks-guards", "search#test:unit"]);
  assert.equal(gaps.filter(gap => gap.includes("suite")).length, 1);
  assert.match(gaps.find(gap => gap.includes("suite"))!, /suite search#test:unit: the CI plan expects it, not in this day's test load \(1 of 2 expected suites\)/);
  assert.ok(!gaps.some(gap => gap.includes("pytest-seo")));
});

test("no suite list from the plan is a gap of its own", () => {
  assert.match(testsGaps(["checks-guards"], null).join("\n"), /no expected suite list from scripts\/ci\/junit-suites.mjs/);
});

test("planSuites loads expectedSuites() from the git object", async () => {
  const source = "export const expectedSuites = () => ['b', 'a'];\n";
  const exec = async (file: string, args: readonly string[]): Promise<string> => {
    assert.equal(file, "git");
    assert.equal(args.at(-1), `${PAGE_MODULE_REF}:${SUITES_MODULE}`);
    return source;
  };
  assert.deepEqual(await planSuites(exec), ["b", "a"]);
  await assert.rejects(planSuites(async () => "export const expectedSuites = () => [];\n"), /expectedSuites\(\) gave \[\]/);
});

test("an unreadable suite table flags a source error and keeps tests off the count", async () => {
  const exec = async (): Promise<string> => { throw new Error("offline"); };
  const out = await measure(exec, async () => "", async () => "", Date.parse("2026-10-30T00:00:00Z"), async () => { throw new Error("no ref"); });
  assert.ok((out.flagged ?? []).some(item => item.kind === "source_error"));
});
