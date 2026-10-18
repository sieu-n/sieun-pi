// 10-18 owner report on us-metal02: "this box isn't busy (~50% cpu util) but the web server sieu-pi keep crashing, super buggy". On a scratch copy
// of the box chat each sessions list copied all 3,063 Mac rows again and joined each one's mirror path.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { MirroredRows, mirrorPath } from "../src/host-catalogs.ts";

test("another box's rows are copied once while that box keeps the same row", () => {
  const mirrors = new MirroredRows();
  const host = { name: "mac" };
  const row = { sessionId: "s1", sessionFile: "/Users/sieunpark/.prime/agent/sessions/a.jsonl" } as SessionSummary;
  const first = mirrors.row(host as never, row);
  assert.equal(first.sessionFile, mirrorPath(host, row.sessionFile!));
  assert.equal(mirrors.row(host as never, row), first);
  const changed = { ...row, sessionName: "renamed" } as SessionSummary;
  assert.equal(mirrors.row(host as never, changed).sessionName, "renamed");
  const plain = { sessionId: "s2" } as SessionSummary;
  assert.equal(mirrors.row(host as never, plain), plain);
});
