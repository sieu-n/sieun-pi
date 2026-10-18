import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { jobRegistry } from "../src/chat-sources.ts";

// On 10-18 the 05:06 KST catch-up of the 10-17 07:29 slot of "portal stays up" found "portal stays up api portal vp 07:29" taken by an older
// job and made "portal stays up api portal vp 10-18 07:29", dated with the day it ran. The real 10-18 07:29 run then found both names taken,
// and its start failed with "no session after 2 creates". The "ci system VP of CI 10-18 07:39" run was lost the same way.

const kst = (iso: string): number => Date.parse(`${iso}+09:00`);
const refusal = (name: string) => new Error(`Agent name "${name}" is unavailable: an agent of that name already exists at depth 0 under this parent`);

async function host(taken: Set<string>, now: number) {
  const dir = await mkdtemp(join(tmpdir(), "duty-name-taken-"));
  const creates: string[] = [];
  const briefs: string[] = [];
  const jobs = dutyJobHost({ rows: async () => [], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/b/${id}.json`, lookupWaitsMs: [0],
    now: () => now, archives: { async add() {} }, sleep: async () => {}, threads: {
      async create(input) {
        creates.push(input.name);
        if (taken.has(input.name)) throw refusal(input.name);
        taken.add(input.name);
        return { id: `s${creates.length}` };
      },
      async prompt(_id, input) { briefs.push(input.message); },
    } });
  return { jobs, creates, briefs };
}

const chat = { id: "01a1301d", name: "api portal vp", cwd: "/repo", board: "/b/01a1301d.json" };
const plain = "portal stays up api portal vp 07:29";

test("duty job name: a catch-up run of yesterday's slot dates its name with the slot's day, so today's run of that slot still gets a free name", async () => {
  const taken = new Set([plain]);
  const catchUp = await host(taken, kst("2026-10-18T05:06:21"));
  const late = await catchUp.jobs.start(chat, plain, `# ${plain}: the duty`, false, kst("2026-10-17T07:29:00"));
  assert.equal(late.name, "portal stays up api portal vp 10-17 07:29");
  const today = await host(taken, kst("2026-10-18T07:34:33"));
  const job = await today.jobs.start(chat, plain, `# ${plain}: the duty`, false, kst("2026-10-18T07:29:00"));
  assert.deepEqual([job.name, today.briefs], ["portal stays up api portal vp 10-18 07:29", ["# portal stays up api portal vp 10-18 07:29: the duty"]]);
});

test("duty job name: when the plain and the dated name are both taken, the run takes a numbered name instead of failing", async () => {
  const taken = new Set([plain, "portal stays up api portal vp 10-18 07:29", "portal stays up api portal vp 10-18 07:29 (2)"]);
  const today = await host(taken, kst("2026-10-18T07:34:33"));
  const job = await today.jobs.start(chat, plain, "brief", false, kst("2026-10-18T07:29:00"));
  assert.equal(job.name, "portal stays up api portal vp 10-18 07:29 (3)");
  assert.deepEqual(today.creates, [plain, "portal stays up api portal vp 10-18 07:29", "portal stays up api portal vp 10-18 07:29 (2)",
    "portal stays up api portal vp 10-18 07:29 (3)"], "a taken name is no failed create");
});
