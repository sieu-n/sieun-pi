import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRuntime } from "./faux.ts";

test("the faux runtime answers one prompt in an isolated agent dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-stack-faux-"));
  try {
    const rt = await openRuntime({ root });
    await rt.session.prompt("hi");
    assert.equal(rt.session.getLastAssistantText(), "faux reply");
    await rt.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
