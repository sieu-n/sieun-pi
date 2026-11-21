import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consolesReport } from "../../server/consoles.ts";
import { resolveCell } from "../../web/src/lib/api/shared/consoles.ts";

test("a cell reads as none, the tier it is the same as, or a console with its tunnel, TablePlus group, access and key names", async t => {
  const dir = mkdtempSync(join(tmpdir(), "consoles-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "consoles.json");
  writeFileSync(file, JSON.stringify({
    tiers: ["local", "staging", "prod"],
    tier_names: { local: "Local dev", prod: "Prod" },
    consoles: [
      { id: "hdx", name: "HyperDX", group: "obs", cells: {
        local: { none: "prod box only" },
        staging: { same_as: "prod" },
        prod: { url: "https://box:8443/", tunnel: "ssh -N box", access: "rw", sign_in: "password", user: { file: "apps/infra/.env", key: "HDX_OWNER_EMAIL" }, secret: { compose: "PW" } },
      } },
      { name: "no id, dropped" },
    ],
  }));
  const { table, readError } = await consolesReport(file);
  assert.equal(readError, null);
  assert.deepEqual(table?.tiers, [{ id: "local", name: "Local dev" }, { id: "staging", name: "staging" }, { id: "prod", name: "Prod" }]);
  assert.equal(table?.rows.length, 1);
  const row = table!.rows[0]!;
  assert.deepEqual(resolveCell(row, "local"), { cell: { kind: "none", text: "prod box only" }, sameAs: null });
  const staging = resolveCell(row, "staging");
  assert.equal(staging.sameAs, "prod");
  assert.deepEqual(staging.cell, { kind: "open", url: "https://box:8443/", tunnel: "ssh -N box", tableplus: null, access: "rw", signIn: "password", user: { file: "apps/infra/.env", key: "HDX_OWNER_EMAIL" }, secret: { compose: "PW" }, note: null });
});

test("a missing or broken file answers no table and says why", async t => {
  const dir = mkdtempSync(join(tmpdir(), "consoles-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match((await consolesReport(join(dir, "none.json"))).readError ?? "", /No consoles file/);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.match((await consolesReport(join(dir, "bad.json"))).readError ?? "", /not JSON/);
});
