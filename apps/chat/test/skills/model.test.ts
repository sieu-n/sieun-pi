import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInventory } from "../../web/src/lib/api/shared/skills.ts";
import { flagBadges, grouped, rowDetail, splitFrontmatter } from "../../web/src/pages/skills/model.ts";

const row = (over: Record<string, unknown>) => ({ id: "box1:a", name: "a", kind: "ours", box: "box1", path: "/home/sieun/x/SKILL.md", ...over });

test("the page groups rows by kind, filters flagged ones and adds a duplicate badge the scanner left out", () => {
  const inventory = parseInventory({
    skills: [row({ id: "1", name: "zeta" }), row({ id: "2", name: "alpha", duplicateOf: ["1"] }), row({ id: "3", name: "up", kind: "upstream", upstream: { url: "u", status: "drift" } })],
  })!;
  assert.deepEqual(grouped(inventory.skills, "all", "").map(g => [g.group.kind, g.rows.map(r => r.name)]), [["ours", ["alpha", "zeta"]], ["upstream", ["up"]]]);
  assert.deepEqual(grouped(inventory.skills, "flagged", "").flatMap(g => g.rows.map(r => r.name)), ["alpha", "up"]);
  assert.deepEqual(grouped(inventory.skills, "all", "ZET").flatMap(g => g.rows.map(r => r.name)), ["zeta"]);
  assert.deepEqual(flagBadges(inventory.skills[1]!).map(b => b.label), ["duplicate"]);
  assert.deepEqual(flagBadges(inventory.skills[2]!).map(b => b.label), ["drift"]);
  assert.deepEqual(splitFrontmatter("---\nname: a\n---\nbody"), { frontmatter: "name: a", body: "body" });
});

test("a row's second line shows its path, its loaders and its last use", () => {
  const [one] = parseInventory({ skills: [row({ loadedBy: { agents: ["vent", "agent factory"] }, uses: [{ at: "2026-11-20T01:00:00Z", session: "t1", agent: "vent" }] })] })!.skills;
  assert.equal(rowDetail(one!, Date.parse("2026-11-20T03:00:00Z")), "~/x/SKILL.md · loaded by vent, agent factory · last used 2 h ago by vent");
});
