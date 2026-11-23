import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Skills } from "../../server/skills.ts";
import { parseInventory, useConversation, type SkillScan, type SkillsReport } from "../../web/src/lib/api/shared/skills.ts";

const row = (over: Record<string, unknown>) => ({ id: "box1:a", name: "a", kind: "ours", box: "box1", path: "/nowhere/SKILL.md", ...over });

function folder(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a read never starts a scan; a scan starts once, a second start joins it, and its end comes after the new inventory parsed", async t => {
  const dir = folder(t);
  const inventory = join(dir, "inventory.json");
  const count = join(dir, "runs");
  const script = join(dir, "scan.sh");
  writeFileSync(script, `sleep 0.3; echo x >> "${count}"; printf '{"skills":[{"id":"box1:u","name":"unslop","kind":"ours","box":"box1","path":"/x"}]}' > "${inventory}"\n`);
  const events: SkillScan[] = [];
  let atEnd: Promise<SkillsReport> | undefined;
  const skills = new Skills({ inventory, scanner: { command: "sh", args: [script], cwd: dir } }, "box1", () => {}, scan => {
    events.push(scan);
    if (!scan.running) atEnd = skills.report();
  });
  const first = await skills.report();
  assert.equal(first.inventory, null);
  assert.match(first.readError ?? "", /No inventory/);
  assert.equal(first.scan.running, false, "a read starts no scan");
  const started = skills.startScan();
  assert.equal(started.scan.running, true);
  const joined = skills.startScan();
  assert.equal(joined.done, started.done, "the second start joined the running scan");
  assert.equal((await skills.report()).scan.running, true);
  await started.done;
  assert.deepEqual(events.map(e => e.running), [true, false]);
  assert.equal(events[1]!.error, null);
  assert.deepEqual((await atEnd)?.inventory?.skills.map(s => s.name), ["unslop"], "a read at the end event gets the new inventory");
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1);
});

test("a read parses the file once and again only when it changed", async t => {
  const dir = folder(t);
  const inventory = join(dir, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ skills: [row({})] }));
  const skills = new Skills({ inventory, scanner: null }, "box1");
  const [a, b] = await Promise.all([skills.report(), skills.report()]);
  assert.equal(a.inventory?.skills.length, 1);
  assert.equal(a.inventory, b.inventory, "two reads share one parse");
  assert.equal((await skills.report()).inventory, a.inventory, "an unchanged file is not parsed again");
  writeFileSync(inventory, JSON.stringify({ skills: [row({}), row({ id: "box1:b", name: "b" })] }));
  utimesSync(inventory, new Date(), new Date(Date.now() + 5000));
  const changed = await skills.report();
  assert.deepEqual(changed.inventory?.skills.map(s => s.id), ["box1:a", "box1:b"]);
  rmSync(inventory);
  const gone = await skills.report();
  assert.equal(gone.inventory, null);
  assert.match(gone.readError ?? "", /No inventory/);
});

test("a failed scan keeps the last inventory and names its error", async t => {
  const dir = folder(t);
  const inventory = join(dir, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ skills: [row({})] }));
  const skills = new Skills({ inventory, scanner: { command: "sh", args: ["-c", "echo 'no scanner here' >&2; exit 2"], cwd: dir } }, "box1");
  await skills.startScan().done;
  const after = await skills.report();
  assert.equal(after.scan.error, "no scanner here");
  assert.equal(after.inventory?.skills.length, 1);
});

test("a clean scan logs each skipped part it names, as one plain line, and no failure", async t => {
  const dir = folder(t);
  const inventory = join(dir, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ skills: [row({})] }));
  const lines: string[] = [];
  const script = "echo 'skipped the Mac scan: this box has no ssh client' >&2; echo 'some progress' >&2";
  const skills = new Skills({ inventory, scanner: { command: "sh", args: ["-c", script], cwd: dir } }, "box1", line => lines.push(line));
  await skills.startScan().done;
  assert.deepEqual(lines, ["skills: skipped the Mac scan: this box has no ssh client"]);
  assert.equal((await skills.report()).scan.error, null);
});

test("a doc reads the file on this box, the carried text of a row on another box, and names related rows", async t => {
  const dir = folder(t);
  const inventory = join(dir, "inventory.json");
  const file = join(dir, "SKILL.md");
  writeFileSync(file, "---\nname: a\n---\n# A\n");
  writeFileSync(inventory, JSON.stringify({
    skills: [
      row({ path: file, duplicateOf: ["mac:b"] }),
      row({ id: "mac:b", name: "b", box: "mac", kind: "fork", text: "# B on the Mac\n" }),
      row({ id: "mac:c", name: "c", box: "mac" }),
    ],
  }));
  const skills = new Skills({ inventory, scanner: null }, "box1");
  const local = await skills.doc("box1:a");
  assert.equal(local.text, "---\nname: a\n---\n# A\n");
  assert.deepEqual(local.related.map(r => r.id), ["mac:b"]);
  assert.equal((await skills.doc("mac:b")).text, "# B on the Mac\n");
  const away = await skills.doc("mac:c");
  assert.equal(away.text, null);
  assert.match(away.textError ?? "", /lives on mac/);
  await assert.rejects(skills.doc("nope"), /No skill nope/);
});

test("the inventory parser keeps readable rows, and a pi-host use links its conversation", () => {
  const inventory = parseInventory({
    skills: [
      row({ uses: [{ at: "2026-11-20T01:00:00Z", session: "t1", runtime: "pi-host", conversation: 3, entry: 9 }, { at: "2026-11-20T02:00:00Z", session: "t1", conversation: 1, entry: 4 }] }),
      { kind: "ours" },
      row({ id: "box1:b", name: "b", kind: "mystery", useful: { verdict: "maybe" } }),
    ],
  });
  assert.ok(inventory);
  assert.deepEqual(inventory.skills.map(s => [s.id, s.kind, s.useful.verdict]), [["box1:a", "ours", null], ["box1:b", "other", null]]);
  const [newest, older] = inventory.skills[0]!.uses;
  assert.equal(useConversation(newest!), "t1");
  assert.equal(useConversation(older!), "t1:3");
  assert.equal(useConversation({ ...newest!, runtime: "prime" }), null);
  assert.equal(parseInventory({ nope: true }), null);
});
