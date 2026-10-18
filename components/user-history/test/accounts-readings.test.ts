// 10-18 owner report on us-metal02: "the web server sieu-pi keep crashing, super buggy". Each chat switch asked api/accounts, which ran 4 pi-pool
// processes and took 1.0 to 2.2 s on the box and 5.1 to 14 s from the owner's Mac. The answer now comes from the last reading at once, and every
// reader of the pool shares one `pi-pool snapshot` per tick (readPoolStatus): on 10-18 at 11:44Z the chat ran the CLI about 3 times a second.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { askHookd, listAccounts, parsePoolSnapshot, readSnapshot, PoolStatusReader, snapshotArgs, threadKey, type PoolPart, type PoolSnapshot, type PoolThread } from "../src/chat-pool.ts";

const part = (out: unknown, code = 0): PoolPart => ({ code, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });
const listing = (provider: string, email: string) => ({ provider, rows: [{ id: email, email, usage: "1%", reason: null, usable: true, current: true, pinned: false }] });

/** A fake `pi-pool snapshot`: each call waits for `answer`; the account email names the call, so a test sees which read answered. */
function fakePool() {
  const calls: { threads: readonly PoolThread[]; answer: (fail?: Error) => void }[] = [];
  const read = (threads: readonly PoolThread[]) => new Promise<PoolSnapshot>((resolve, reject) => {
    const n = calls.length + 1;
    calls.push({ threads, answer: fail => fail ? reject(fail) : resolve({ queue: part({ n }), config: part({ lease_s: n }),
      threads: threads.map(thread => ({ ...thread, who: part({ session: thread.session, priority: "high", providers: {} }),
        ls: { anthropic: part(listing("anthropic", `call${n}@a`)), "openai-codex": part(listing("openai-codex", `call${n}@o`)) } })) }) });
  });
  return { calls, read };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const email = (view: Awaited<ReturnType<typeof listAccounts>>) => view.providers[0]!.rows[0]?.email;

/** A clock the test moves, and a sleep that ends when the clock passes its time. */
function clock() {
  let at = 1_000_000;
  const sleepers: { until: number; wake: () => void }[] = [];
  return {
    now: () => at,
    sleep: (ms: number) => new Promise<void>(wake => { sleepers.push({ until: at + ms, wake }); }),
    advance(ms: number) { at += ms; for (const sleeper of sleepers.splice(0)) if (sleeper.until <= at) sleeper.wake(); else sleepers.push(sleeper); },
  };
}

test("concurrent readers share one snapshot call, and a second within the tick answers from it", async () => {
  const pool = fakePool(), time = clock();
  const status = new PoolStatusReader(pool.read, 2000, time.now, time.sleep);
  const t1 = { session: "t1", model: "opus" };
  const reads = [status.current(), status.current([t1]), status.current([t1]), status.current()];
  await settle();
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0]!.threads, [t1]);
  pool.calls[0]!.answer();
  const answers = await Promise.all(reads);
  assert.ok(answers.every(answer => answer.queue.out === '{"n":1}'));
  time.advance(1999);
  await status.current([t1]);
  assert.equal(pool.calls.length, 1, "a reading younger than the tick answers without a call");
});

test("asks after a read wait for the next tick and go out as one call with every thread they named", async () => {
  const pool = fakePool(), time = clock();
  const status = new PoolStatusReader(pool.read, 2000, time.now, time.sleep);
  const first = status.current();
  await settle();
  pool.calls[0]!.answer();
  await first;
  time.advance(500);
  const later = [status.current([{ session: "a", model: null }]), status.current([{ session: "b", model: "m" }]), status.current()];
  await settle();
  assert.equal(pool.calls.length, 1, "no call before the tick ends");
  time.advance(1500);
  await settle(); await settle();
  assert.equal(pool.calls.length, 2);
  assert.deepEqual(pool.calls[1]!.threads.map(threadKey), ["a|", "b|m"]);
  pool.calls[1]!.answer();
  const [a, b] = await Promise.all(later);
  assert.equal(JSON.parse(a!.threads.get("a|")!.ls.anthropic.out).rows[0].email, "call2@a");
  assert.ok(b!.threads.has("b|m"));
});

test("a read that fails answers with the last good reading, and fails only when nothing was read", async () => {
  const pool = fakePool(), time = clock();
  const status = new PoolStatusReader(pool.read, 0, time.now, time.sleep);
  const none = status.current();
  await settle();
  pool.calls[0]!.answer(new Error("pi-pool failed: boom"));
  await assert.rejects(none, /boom/);
  const good = status.current();
  await settle(); await settle();
  pool.calls[1]!.answer();
  await good;
  time.advance(10);
  const after = status.current();
  await settle(); await settle();
  pool.calls[2]!.answer(new Error("pi-pool failed: again"));
  assert.equal((await after).queue.out, '{"n":2}');
});

test("the accounts frame answers from the last reading at once and asks for its thread in the next shared read", async () => {
  const pool = fakePool(), time = clock();
  const status = new PoolStatusReader(pool.read, 2000, time.now, time.sleep);
  const first = listAccounts("t1", "opus", { status });
  await settle();
  assert.equal(pool.calls.length, 1);
  pool.calls[0]!.answer();
  assert.equal(email(await first), "call1@a");
  assert.equal((await first).priority, "high");

  time.advance(2001);
  const subscribes = Array.from({ length: 20 }, () => listAccounts("t1", "opus", { status }));
  void listAccounts("t2", null, { status });
  assert.ok((await Promise.all(subscribes)).every(view => email(view) === "call1@a"), "a subscribe answers from the snapshot without waiting");
  await settle(); await settle();
  assert.equal(pool.calls.length, 2, "twenty subscribes and another thread make one call");
  assert.deepEqual(pool.calls[1]!.threads.map(threadKey), ["t1|opus", "t2|"]);
  pool.calls[1]!.answer();
  await settle();
  assert.equal(email(await listAccounts("t1", "opus", { status })), "call2@a");
});

test("a pool change drops the readings, so the next ask waits for a new one", async () => {
  const pool = fakePool(), time = clock();
  const status = new PoolStatusReader(pool.read, 2000, time.now, time.sleep);
  const first = listAccounts("t1", null, { status });
  await settle();
  pool.calls[0]!.answer();
  await first;
  status.forget();
  const after = listAccounts("t1", null, { status });
  await settle(); await settle();
  assert.equal(pool.calls.length, 2, "after a change the read starts without waiting for the tick");
  pool.calls[1]!.answer();
  assert.equal(email(await after), "call2@a");
});

test("a snapshot part that failed reads as the separate command's failure", async () => {
  const pool = { read: async (threads: readonly PoolThread[]): Promise<PoolSnapshot> => ({ queue: part({}), config: part("", 1),
    threads: threads.map(thread => ({ ...thread, who: part({ error: "--session t9 matches no known session" }, 2),
      ls: { anthropic: part({ error: "--session t9 matches no known session" }, 2), "openai-codex": part(listing("openai-codex", "x@o")) } })) }) };
  const view = await listAccounts("t9", null, { status: new PoolStatusReader(pool.read, 0) });
  assert.match(view.providers[0]!.error!, /matches no known session/);
  assert.equal(view.providers[1]!.rows[0]!.email, "x@o");
  assert.equal(view.poolConfig, null);
});

test("the snapshot argv names each thread, with empty strings for no session or model, and its answer parses at the edge", () => {
  assert.deepEqual(snapshotArgs([{ session: null, model: null }, { session: "s", model: "m" }]), ["snapshot", "--json", "--thread", "", "", "--thread", "s", "m"]);
  assert.throws(() => parsePoolSnapshot({ queue: part({}), config: part({}), threads: [{ session: "s", model: null, who: part({}), ls: { anthropic: part({}) } }] }), /invalid snapshot thread/);
});

/** Whether `request` holds a whole PPH1 request: the magic, 4 fields, argc and its argv, envc and its entries. */
function whole(request: Buffer): boolean {
  const fields = request.toString("utf8").split("\0");
  if (fields.length < 7) return false;
  const argc = Number(fields[5]), envAt = 6 + argc;
  return fields.length > envAt + 1 && fields.length - 1 >= envAt + 1 + Number(fields[envAt]);
}

/** A fake hookd that reads a whole request, without waiting for an end the client never sends, and answers it. */
async function socketServer(answer: (request: Buffer) => string | null): Promise<{ path: string; server: Server; requests: Buffer[] }> {
  const path = join(mkdtempSync(join(tmpdir(), "hookd-")), "hook.sock");
  const requests: Buffer[] = [];
  const server = createServer(connection => {
    const chunks: Buffer[] = [];
    connection.on("error", () => {});
    connection.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const request = Buffer.concat(chunks);
      if (!whole(request)) return;
      requests.push(request);
      const said = answer(request);
      if (said !== null) connection.write(said);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { path, server, requests };
}

test("hookd gets PPH1 and NUL-ended fields, and its J line is the command's answer", async () => {
  const hookd = await socketServer(() => 'J {"code":0,"out":"{}\\n","err":""}\n');
  try {
    const said = await askHookd(hookd.path, "/opt/pool/bin/pi-pool", ["snapshot", "--json", "--thread", "", ""], { A: "1", B: "x=y" });
    assert.deepEqual(said, { code: 0, out: "{}\n", err: "" });
    const fields = hookd.requests[0]!.toString("utf8").split("\0");
    assert.deepEqual(fields, ["PPH1", "pipe", String(process.pid), process.cwd(), "/opt/pool/bin/pi-pool", "5", "snapshot", "--json", "--thread", "", "", "2", "A=1", "B=x=y", ""]);
  } finally { hookd.server.close(); }
});

test("an F answer, no socket, or no answer in time gives null, and the caller runs the CLI", async () => {
  const refuses = await socketServer(() => "F\n");
  const silent = await socketServer(() => null);
  try {
    assert.equal(await askHookd(refuses.path, "/bin/pi-pool", ["config"], {}), null);
    assert.equal(await askHookd(join(tmpdir(), "no-such-dir-9f", "hook.sock"), "/bin/pi-pool", ["config"], {}), null);
    const started = Date.now();
    assert.equal(await askHookd(silent.path, "/bin/pi-pool", ["config"], {}, 200), null);
    assert.ok(Date.now() - started < 2000);
  } finally { refuses.server.close(); silent.server.close(); }
});

test("the client keeps its side open until the answer, since hookd stops a run whose client went away", async () => {
  let ended = false;
  const hookd = await socketServer(() => null);
  hookd.server.on("connection", connection => connection.on("end", () => { ended = true; }));
  try {
    const answer = askHookd(hookd.path, "/bin/pi-pool", ["config"], {}, 300);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(hookd.requests.length, 1);
    assert.equal(ended, false);
    assert.equal(await answer, null);
  } finally { hookd.server.close(); }
});

test("a pool installed before `snapshot` answers with its usage text, and the tick runs the separate reads instead", async () => {
  const asked: string[][] = [];
  const oldPool = async (args: readonly string[]): Promise<PoolPart> => {
    asked.push([...args]);
    if (args[0] === "snapshot") return { code: 1, out: "", err: "usage: pi-pool [command]\n  status [--provider <p>] ...\n" };
    return part({ argv: args });
  };
  const snapshot = await readSnapshot([{ session: "s1", model: "opus" }, { session: null, model: null }], oldPool);
  assert.deepEqual(asked.slice(1).map(args => args.join(" ")).sort(), ["config", "ls --json --provider anthropic", "ls --json --provider anthropic --session s1 --model opus",
    "ls --json --provider openai-codex", "ls --json --provider openai-codex --session s1 --model opus", "queue --json", "who --json", "who --json --session s1 --model opus"]);
  assert.deepEqual(JSON.parse(snapshot.queue.out).argv, ["queue", "--json"]);
  assert.deepEqual(snapshot.threads.map(thread => [thread.session, thread.model, JSON.parse(thread.ls["openai-codex"].out).argv.at(-1)]),
    [["s1", "opus", "opus"], [null, null, "openai-codex"]]);
});

test("a snapshot that fails for another reason fails the read, so readers keep the last good reading", async () => {
  const asked: string[][] = [];
  const broken = async (args: readonly string[]): Promise<PoolPart> => { asked.push([...args]); return { code: 1, out: "", err: "Traceback: boom\n" }; };
  await assert.rejects(readSnapshot([], broken), /boom/);
  assert.equal(asked.length, 1);
});
