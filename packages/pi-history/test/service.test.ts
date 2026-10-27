import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { truncateSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { append, assistant, getJson, header, named, ROOT, tempHome, toolResult, until, user, write } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
});

function startService(home: string, dirs: string[]) {
  const socket = join(home, "history.sock");
  const db = join(home, "history.db");
  const child = spawn(process.execPath, [MAIN, "--db", db, "--socket", socket, ...dirs.flatMap((d) => ["--dir", d])], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: home },
  });
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += c));
  children.push(child);
  return { child, socket, db, stderr: () => stderr };
}

function kinds(dbPath: string, text?: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = (text
      ? db.prepare("SELECT d.kind FROM fts JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ? ORDER BY d.id").all(text)
      : db.prepare("SELECT kind FROM docs ORDER BY id").all()) as { kind: string }[];
    return rows.map((r) => r.kind);
  } finally {
    db.close();
  }
}

test("the service indexes appended lines, answers /v1/status on its socket and reindexes a truncated rewrite", async () => {
  const t = tempHome();
  write(t.rootFile, header(ROOT), named("vp chat"), user("first ask"));
  const svc = startService(t.home, t.dirs);
  const first = await until("status with the backfilled doc", async () => {
    const s = await getJson(svc.socket, "/v1/status");
    return s.docs === 1 && s.backfillPct === 100 && s;
  });
  assert.equal(first.files, 1);
  assert.equal(typeof first.box, "string");
  assert.ok(first.dbBytes > 0);

  append(t.rootFile, assistant("zebracorn plan", { name: "ipython", code: "print('zebracorn')" }), toolResult("zebracorn done"));
  await until("the appended docs", async () => (await getJson(svc.socket, "/v1/status")).docs === 5);
  assert.deepEqual(kinds(svc.db, "zebracorn"), ["assistant", "thinking", "tool_call", "tool_result"]);
  const tail = await getJson(svc.socket, "/v1/status");
  assert.equal(typeof tail.lagP50Ms, "number");
  assert.equal(typeof tail.lagP99Ms, "number");
  assert.ok(tail.newestAt > 0);

  truncateSync(t.rootFile, 0);
  append(t.rootFile, header(ROOT), user("after the rewrite"));
  await until("the reindexed file", async () => (await getJson(svc.socket, "/v1/status")).docs === 1);
  assert.deepEqual(kinds(svc.db), ["user"]);
  assert.deepEqual(kinds(svc.db, "zebracorn"), []);
});

test("a service killed mid-backfill resumes without duplicate docs", async () => {
  const t = tempHome();
  const body = [header(ROOT), named("big")];
  for (let i = 0; i < 200_000; i++) body.push(user(`ask ${i} ${"word ".repeat(40)}`));
  write(t.rootFile, body.join(""));
  const first = startService(t.home, t.dirs);
  await until(
    "a partial backfill",
    async () => {
    const s = await getJson(first.socket, "/v1/status");
      return s.docs > 0 && s.docs < 200_000;
    },
    30_000,
  );
  first.child.kill("SIGKILL");
  await new Promise((r) => first.child.once("exit", r));
  const second = startService(t.home, t.dirs);
  await until("the finished backfill", async () => (await getJson(second.socket, "/v1/status")).backfillPct === 100, 60_000);
  const db = new DatabaseSync(second.db, { readOnly: true });
  const total = Number((db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n);
  const distinct = Number((db.prepare("SELECT count(DISTINCT text) AS n FROM docs").get() as { n: number }).n);
  db.close();
  assert.equal(total, 200_000);
  assert.equal(distinct, 200_000);
});
