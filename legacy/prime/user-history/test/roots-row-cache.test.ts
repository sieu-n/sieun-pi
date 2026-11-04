// d7 11-04: at 23:45:49Z on 11-03 an api/agent/siblings read built the roots of every box (7,871 top-level rows) and sat 0.96 s inside
// sessionTitle with CI on 39 of 80 cores; d7 read a 1.1 s loop stall and a 1.1 s siblings read. Each row's root is now built once per row
// object and host, so a read after it works out no unchanged row's title again.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { rootRowsOf } from "../src/chat-server.ts";
import { rootsOf } from "../src/cross-host-message.ts";

function counted(n: number): { rows: SessionSummary[]; reads: () => number } {
  let reads = 0;
  const rows = Array.from({ length: n }, (_, at) => {
    const row = { sessionId: `01a1a3bd-0000-7000-8000-${String(at).padStart(12, "0")}`, cwd: "/tmp", lifecycle: "saved", activity: "idle" } as unknown as SessionSummary;
    Object.defineProperty(row, "sessionName", { enumerable: true, get: () => { reads += 1; return `job ${at}`; } });
    return row;
  });
  return { rows, reads: () => reads };
}

test("a second roots build reads no unchanged row's title, and a changed row or host is built again", () => {
  const { rows, reads } = counted(500);
  const first = rootsOf(rootRowsOf(rows, () => "us-metal02"), new Set());
  const once = reads();
  assert.ok(once >= 500);
  const second = rootsOf(rootRowsOf(rows, () => "us-metal02"), new Set());
  assert.equal(reads(), once, "the second build worked out titles again");
  assert.deepEqual(second, first);
  rows[3] = { ...rows[3]!, sessionName: "renamed", activity: "working" } as SessionSummary;
  const third = rootsOf(rootRowsOf(rows, id => id === rows[7]!.sessionId ? "mac" : "us-metal02"), new Set());
  assert.equal(third[3]?.name, "renamed");
  assert.equal(third[3]?.status, "working");
  assert.equal(third[7]?.host, "mac", "a row whose host moved gets its new host");
  assert.equal(third[8]?.host, "us-metal02");
});
