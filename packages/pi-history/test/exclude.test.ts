import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/core/db.ts";
import { Indexer } from "../src/core/indexer.ts";
import { append, assistant, getJson, header, line, named, tempHome, toolResult, until, user, write } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const VENT_SUB = "01a14dd5-0000-7000-8000-00000000aaaa";
const JOB_BY_NAME = "01a14dd5-0000-7000-8000-00000000bbbb";
const JOB_BY_ID = "01a14dd5-0000-7000-8000-00000000cccc";
const JOB_SUB = "01a14dd5-0000-7000-8000-00000000dddd";
const OTHER = "01a14dd5-0000-7000-8000-00000000eeee";
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
});

const call = (code: string) =>
  line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: { code } }] } });

test("a Vent tree keeps its user and assistant text in the index and never its tool calls or results", async () => {
  const t = tempHome();
  const sessions = t.dirs[0]!;
  const artifacts = t.dirs[1]!;
  const file = (dir: string, id: string) => {
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.jsonl`);
  };
  const ventRoot = file(sessions, VENT);
  const ventSub = file(join(artifacts, VENT, "sub-0000aaaa"), VENT_SUB);
  const jobByName = file(sessions, JOB_BY_NAME);
  const jobById = file(sessions, JOB_BY_ID);
  const jobSub = file(join(artifacts, JOB_BY_NAME, "sub-0000dddd", "sub-0000eeee"), JOB_SUB);
  const other = file(sessions, OTHER);
  write(ventRoot, header(VENT), named("vent"), user("ventuserone rotate the key"), assistant("ventreplyone done"), call("TOKEN='ventsecretone'"), toolResult("ventsecrettwo"));
  write(ventSub, header(VENT_SUB), named("vent helper"), assistant("ventreplytwo"), toolResult("ventsecretthree"));
  write(jobByName, header(JOB_BY_NAME), named("vent deploy job"), user("ventuserjob"), toolResult("ventsecretfour"));
  write(jobById, header(JOB_BY_ID), named("vent id job"), toolResult("ventsecretfive"));
  write(jobSub, header(JOB_SUB), named("deep helper"), toolResult("ventsecretsix"));
  write(other, header(OTHER), named("other chat"), toolResult("othersecretok"));
  const chatData = join(t.home, "browser-chat");
  mkdirSync(chatData, { recursive: true });
  writeFileSync(
    join(chatData, "chat-jobs.json"),
    JSON.stringify({ jobs: { "vent deploy job": { chat: "vent", chatId: VENT }, [JOB_BY_ID]: { chat: "vent" }, "unrelated job": { chat: "other chat" } } }),
  );

  const dbPath = join(t.home, "history.db");
  const before = new Indexer({ db: openDb(dbPath), dirs: t.dirs });
  await before.start();
  await before.idle();
  await before.stop();
  const secretDocs = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number((db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH 'ventsecretone OR ventsecrettwo OR ventsecretthree OR ventsecretfour OR ventsecretfive OR ventsecretsix'").get() as { n: number }).n)
        + Number((db.prepare("SELECT count(*) AS n FROM docs WHERE text LIKE '%ventsecret%'").get() as { n: number }).n);
    } finally {
      db.close();
    }
  };
  assert.equal(secretDocs(), 12, "an index built with no policy holds the Vent tool docs the service has to purge");
  before.db.close();

  const socket = join(t.home, "history.sock");
  const child = spawn(process.execPath, [MAIN, "--db", dbPath, "--socket", socket, ...t.dirs.flatMap((d) => ["--dir", d])], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, HOME: t.home, AGENT_CHAT_DATA_DIR: chatData, PI_HISTORY_SETTINGS: join(t.home, "settings.json"), SIEUN_PI_CONFIG_DIR: join(t.home, "sieun-pi") },
  });
  children.push(child);
  const search = (q: string) => getJson(socket, `/v1/search?q=${encodeURIComponent(q)}&limit=100`);
  await until("the service", async () => (await getJson(socket, "/v1/status")).backfillPct === 100);
  assert.equal(secretDocs(), 0, "the service drops tool docs a Vent root already had");

  const newSub = file(join(artifacts, VENT, "sub-0000ffff"), "01a14dd5-0000-7000-8000-00000000ffff");
  append(ventRoot, user("ventuserlate"), call("ventsecretseven"), toolResult("ventsecreteight"));
  write(newSub, header("01a14dd5-0000-7000-8000-00000000ffff"), named("late helper"), toolResult("ventsecretnine"), assistant("ventreplylate"));
  await until("the appended Vent text", async () => (await search("ventuserlate")).total === 1 && (await search("ventreplylate")).total === 1);

  for (let i = 0; i < 3; i++) {
    for (const q of ["ventsecretone", "ventsecrettwo", "ventsecretthree", "ventsecretfour", "ventsecretfive", "ventsecretsix", "ventsecretseven", "ventsecreteight", "ventsecretnine"]) {
      assert.equal((await search(q)).total, 0, `${q} is not found`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(secretDocs(), 0);
  for (const q of ["ventuserone", "ventreplyone", "ventreplytwo", "ventuserjob"]) assert.equal((await search(q)).total, 1, `${q} is found`);
  assert.equal((await search("othersecretok")).total, 1, "tool results of other chats stay searchable");
});
