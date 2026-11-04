// On 11-03 and 11-04 the :5182 chat's profiles showed about 8 main-thread waits of 0.4 to 0.7 s inside the SyncWriteStream that Node gives a
// stdout or stderr that is a file, which is how systemd and launchd hand the chat its service.log.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const module = fileURLToPath(new URL("../src/async-log.ts", import.meta.url));

test("a serve's log lines to a file leave the main thread, keep their order and are all written at exit", async t => {
  const dir = await mkdtemp(join(tmpdir(), "async-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "service.log"), result = join(dir, "result.json"), child = join(dir, "child.mts");
  await writeFile(child, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    let sync = 0;
    const writeSync = fs.writeSync;
    fs.writeSync = (...args) => { sync++; return writeSync(...args); };
    syncBuiltinESMExports();
    const { asyncFileLogs } = await import(${JSON.stringify(module)});
    const taken = asyncFileLogs();
    for (let at = 0; at < 100; at++) (at % 2 ? process.stdout : process.stderr).write(\`line \${at}\\n\`);
    const sizeOnReturn = fs.statSync(${JSON.stringify(log)}).size, syncOnReturn = sync;
    await new Promise(done => process.stderr.write("line 100\\n", done));
    const sizeAfter = fs.statSync(${JSON.stringify(log)}).size, syncAfter = sync;
    fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ taken, sizeOnReturn, syncOnReturn, sizeAfter, syncAfter }));
    for (let at = 101; at < 200; at++) (at % 2 ? process.stdout : process.stderr).write(\`line \${at}\\n\`);
    process.exit(0);
  `);
  const fd = openSync(log, "a");
  const run = spawnSync(process.execPath, ["--import", "tsx", child], { stdio: ["ignore", fd, fd], cwd: fileURLToPath(new URL("..", import.meta.url)) });
  closeSync(fd);
  assert.equal(run.status, 0, await readFile(log, "utf8"));
  const seen = JSON.parse(await readFile(result, "utf8"));
  assert.deepEqual(seen.taken, [1, 2], "both streams are files, so both are taken over");
  assert.equal(seen.sizeOnReturn, 0, "100 writes returned before any byte reached the file");
  assert.equal(seen.syncOnReturn, 0, "no writeSync on the calling turn");
  assert.equal(seen.syncAfter, 0, "no writeSync once the pool wrote them");
  assert.equal(seen.sizeAfter, Buffer.byteLength(Array.from({ length: 101 }, (_, at) => `line ${at}\n`).join("")), "the callback fires once the line and all before it are in the file");
  assert.deepEqual((await readFile(log, "utf8")).trimEnd().split("\n"), Array.from({ length: 200 }, (_, at) => `line ${at}`), "every line, in call order, including those written in the exit's turn");
});

test("a TTY or pipe keeps Node's own writer", async () => {
  const { asyncFileLogs } = await import("../src/async-log.ts");
  const write = () => true;
  const pipe = { fd: 99999, write };
  assert.deepEqual(asyncFileLogs([pipe]), []);
  assert.equal(pipe.write, write);
});
