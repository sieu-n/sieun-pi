// Owner rule c146 (2026-10-19 20:20Z): jobs make no host change on the production box us-metal01 and reach it over root ssh no more; prod reads
// go through the read-only roles. Before it, d1, d2 and the DM outreach duty read prod over `ssh root@64.34.205.243` with docker exec psql.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PSQL_ARGS, prodReader } from "../scripts/duties/estate-reads.ts";

const DUTIES = ["estate-reads", "engage-reads", "watchlist-green", "dm-outreach"];

test("the estate read prechecks open no ssh to us-metal01 and no docker exec", () => {
  for (const name of DUTIES) {
    const source = readFileSync(new URL(`../scripts/duties/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /root@|64\.34\.205\.243|spawn\("ssh"|docker exec|\bssh\(/, name);
  }
});

test("prodReader runs psql as owner_ro on the wg-prod gateway in a read-only transaction", async () => {
  const calls: { command: string; args: readonly string[]; app: string | undefined; stdin: string }[] = [];
  const run = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const call = { command, args, app: options.env?.PGAPPNAME, stdin: "" };
    calls.push(call);
    stdin.on("data", chunk => { call.stdin += chunk; });
    stdin.on("finish", () => { child.stdout!.emit("data", "1\t2\n"); child.emit("close", 0); });
    Object.assign(child, { stdin, stdout: new PassThrough(), stderr: new PassThrough() });
    return child;
  }) as never;
  assert.equal(await prodReader("engage-reads-duty", AbortSignal.timeout(5_000), run)("select 1, 2"), "1\t2\n");
  assert.equal(calls[0]!.command, "psql");
  assert.deepEqual(calls[0]!.args, PSQL_ARGS);
  assert.ok(PSQL_ARGS.includes("host=10.250.12.1 port=5432 dbname=crawler_v3 user=owner_ro"));
  assert.equal(calls[0]!.app, "engage-reads-duty");
  assert.equal(calls[0]!.stdin, "set default_transaction_read_only = on;\nselect 1, 2\n");
});
