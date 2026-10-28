// On 10-27 w81-waiting-session run2's criteria header said "Written 2026-10-27 23:58Z" by hand for a file setup copied at 23:53:59Z, and chat-2572's
// controlled run3 had the same slip. So setup records the criteria's registration time and sha256 itself, and the judge fails a run whose
// criteria text changed after registration.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { criteriaChanges, readRegistration, registerCriteria, REGISTRATION_FILE, withCriteriaCheck } from "../scripts/clean-room/criteria-registration.ts";

const HERE = join(import.meta.dirname, "..");
const TEXT = "a. the job resumes on the model it was spawned with\nb. nobody stepped in\n";

function home(): { root: string; source: string; run: string; restore(): void } {
  const root = mkdtempSync(join(tmpdir(), "criteria-registration-"));
  const before = process.env.HOME;
  process.env.HOME = root;
  const source = join(root, ".prime/agent/clean-room/w81/criteria.md");
  const run = join(root, ".prime/agent/clean-room/w81/run2");
  mkdirSync(run, { recursive: true });
  writeFileSync(source, TEXT);
  return { root, source, run, restore: () => { process.env.HOME = before; } };
}

const PASS = { verdict: "pass" as const, text: "# Clean-room run run2: pass\n\n- a met\n- b met\n" };

test("setup writes the registration time from the clock and the sha256 from the file, and keeps the first on a rerun", () => {
  const { source, run, restore } = home();
  try {
    const at = Date.parse("2026-10-27T23:53:59.000Z");
    const registration = registerCriteria(run, source, at);
    const sha = registration.sha256;
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.deepEqual(registration, { registeredAt: "2026-10-27T23:53:59.000Z", sha256: sha, bytes: Buffer.byteLength(TEXT), source: "~/.prime/agent/clean-room/w81/criteria.md" });
    assert.equal(readFileSync(join(run, "criteria.md"), "utf8"), TEXT);
    assert.deepEqual(readRegistration(run), registration);
    // A setup run again with the same folder keeps the first registration.
    assert.equal(registerCriteria(run, source, at + 600_000).registeredAt, "2026-10-27T23:53:59.000Z");
    // and refuses criteria whose text changed since.
    writeFileSync(source, TEXT + "c. a line added later\n");
    assert.throws(() => registerCriteria(run, source, at + 900_000), /not the [0-9a-f]{64} setup registered at 2026-10-27T23:53:59\.000Z/);
  } finally { restore(); }
});

test("the verdict names the registration and stays as the judge found it while the criteria are unchanged", () => {
  const { source, run, restore } = home();
  try {
    registerCriteria(run, source, Date.parse("2026-10-27T23:53:59.000Z"));
    const judged = withCriteriaCheck(run, PASS);
    assert.equal(judged.verdict, "pass");
    assert.match(judged.text, /^# Clean-room run run2: pass\n\nSetup registered the criteria at 2026-10-27T23:53:59\.000Z with sha256 [0-9a-f]{12} \(criteria\.registration\.json\)\.\n\n- a met/);
    assert.deepEqual(criteriaChanges(run), []);
  } finally { restore(); }
});

test("a run whose copy or source criteria changed after registration fails", () => {
  for (const edit of ["copy", "source"] as const) {
    const { source, run, restore } = home();
    try {
      registerCriteria(run, source, Date.parse("2026-10-27T23:53:59.000Z"));
      writeFileSync(edit === "copy" ? join(run, "criteria.md") : source, TEXT.replace("b. nobody", "b. somebody"));
      const judged = withCriteriaCheck(run, PASS);
      assert.equal(judged.verdict, "fail", edit);
      assert.match(judged.text, /^# Clean-room run run2: fail\n\n.*changed after that.*it found pass/, edit);
      assert.match(judged.text, edit === "copy" ? /run2\/criteria\.md reads sha256/ : /~\/\.prime\/agent\/clean-room\/w81\/criteria\.md reads sha256/);
    } finally { restore(); }
  }
});

test("a run set up before setup registered criteria keeps its judge's verdict", () => {
  const { run, restore } = home();
  try {
    writeFileSync(join(run, "criteria.md"), TEXT);
    assert.deepEqual(withCriteriaCheck(run, PASS), PASS);
  } finally { restore(); }
});

test("clean-room.ts judges every run through the criteria check, keeps the registration in the evidence, and setup registers before it makes the chat", () => {
  const source = readFileSync(join(HERE, "scripts/clean-room/clean-room.ts"), "utf8");
  const bare = source.split("\n").filter(line => /\.evaluate\(run, state\)/.test(line) && !line.includes("withCriteriaCheck(run, await") && !line.includes("reopenFirstMessage.evaluate"));
  assert.deepEqual(bare, []);
  assert.equal(source.match(/withCriteriaCheck\(run, await/g)?.length, 3);
  assert.match(source, /"criteria\.md", REGISTRATION_FILE,/);
  const setup = source.slice(source.indexOf("async function setup("));
  assert.ok(setup.indexOf("registerCriteria(run, criteria)") > 0 && setup.indexOf("registerCriteria(run, criteria)") < setup.indexOf("seedTrialHarness("));
  assert.ok(!/copyFileSync\(criteria/.test(source), "setup copies the criteria only through registerCriteria");
  assert.equal(REGISTRATION_FILE, "criteria.registration.json");
});
