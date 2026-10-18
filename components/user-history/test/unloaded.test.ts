import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recordUnloaded, UNLOADED_FILE } from "../src/unloaded.ts";

const script = fileURLToPath(new URL("../../../skills/resume-paused-sessions/scripts/resume_paused.py", import.meta.url));

// ci train (01a14068) was stopped by the idle unload at 10:27:34Z on 10-16 right after its token hook failure, and the resume pass, which
// reads this record, never learned it.
test("the idle unload's record is the one resume_paused.py reads, and entries older than two days drop out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unloaded-"));
  await writeFile(join(dir, UNLOADED_FILE), JSON.stringify({ "01a13000-old0-7000-8000-000000000000": "2026-10-14T00:00:00.000Z" }));
  await recordUnloaded(dir, ["01a14068-faa2-7369-a7d0-0389df1d4632"], Date.parse("2026-10-16T10:27:34.023Z"));
  assert.deepEqual(JSON.parse(await readFile(join(dir, UNLOADED_FILE), "utf8")), { "01a14068-faa2-7369-a7d0-0389df1d4632": "2026-10-16T10:27:34.023Z" });
  const read = execFileSync("python3", ["-B", "-c", [
    "import importlib.util, sys",
    `spec = importlib.util.spec_from_file_location("rp", ${JSON.stringify(script)})`,
    "rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)",
    `print({k: v.isoformat() for k, v in rp.load_unloaded(${JSON.stringify(join(dir, UNLOADED_FILE))}).items()})`,
  ].join("\n")], { encoding: "utf8" });
  assert.equal(read.trim(), "{'01a14068-faa2-7369-a7d0-0389df1d4632': '2026-10-16T10:27:34.023000+00:00'}");
});
