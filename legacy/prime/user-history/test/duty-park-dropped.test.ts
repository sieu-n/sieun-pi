// Replays chat system AI harness developer environment 09:57 (01a18003) on us-metal02, 10-28. Its first turn parked for a working slot at
// 00:59:25Z, the idle unload stopped it at 01:01:59Z, and at 01:06:45Z Prime's wake wrote provider_quota_resume "cancelled" and ran no turn.
// At 01:07:07Z the duty runner read the job as cut, at 01:07:12Z it queued its archive, and the chat sent its continue by hand.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import type { DutyJobRef } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

const JOB: DutyJobRef = { id: "01a18003-e010-7458-a291-d12b168e2d4f", name: "chat system AI harness developer environment 09:57" };
const FIXTURE = join(import.meta.dirname, "fixtures", "duty-park-dropped-1028.jsonl");

test("a duty job whose slot park Prime's wake dropped is still going, so the runner neither ends nor archives it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-park-dropped-"));
  const file = join(dir, `${JOB.id}.jsonl`);
  await copyFile(FIXTURE, file);
  const row = { id: JOB.id, name: JOB.name, cwd: dir, kind: "root", status: "idle", archived: false, messageCount: 3, working: false, subagentsRunning: 0,
    unread: false, tags: [], priority: 0 } as unknown as SessionRow;
  const logs: string[] = [];
  const host = (sessionFile: string) => dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [row], sessionFile: async () => sessionFile, log: line => logs.push(line) });
  try {
    const dropped = host(file);
    assert.deepEqual(await dropped.ended!([], [JOB]), [], "01:07:12Z: the runner queued its archive");
    assert.equal(await dropped.working(JOB), true);
    assert.deepEqual(logs, [`duty job ${JOB.name}: not stopped, its slot park was dropped with no turn, and the job sweep sends it one continue`]);
    const missing = host(join(dir, "gone.jsonl"));
    assert.deepEqual(await missing.ended!([], [JOB]), [JOB], "a job with no dropped park ends as before");
    assert.equal(await missing.working(JOB), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
