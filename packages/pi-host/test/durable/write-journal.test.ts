/**
 * p1330 (11-01): a vent pi-host job's writes into us-metal02's shared auto-sns-agent checkout never reached the write journal, so commit.mjs
 * needed --session and --expect pins to commit them. A durable thread runs none of sieun-rules' tool_call handlers, so its kernel never ran
 * the prelude that loads kernel-journal.py, and an agent thread's RLM_HARNESS_STATE_DIR (the agent's store) names no session id.
 * A durable kernel now loads the journal from sieun-rules' python-journal/sitecustomize.py, it and every Python it starts, with
 * PI_HOST_SESSION_ID naming the conversation.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { ChatDoc } from "../../src/durable/registry.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { cell, context, entriesOf, lastText, openThread, results, rlmOptions, say } from "./rlm-rig.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-journal-")));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "threads"));
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
for (const key of ["AGENT_WRITES_ROOT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_HOST_SESSION_ID", "GLOBAL_RULES", "GLOBAL_RULES_GUARD"]) delete process.env[key];

const checkout = join(dir, "checkout");
mkdirSync(join(checkout, "src"), { recursive: true });
spawnSync("git", ["init", "-q", checkout]);
writeFileSync(join(checkout, ".git/agent-shared-checkout"), `${checkout}\n`);

let rlm: DurableRlm;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const journal = () => {
  const folder = join(checkout, ".cache/agent-writes");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap(day => readdirSync(join(folder, day)).flatMap(name =>
    readFileSync(join(folder, day, name), "utf8").trim().split("\n").filter(Boolean).map(line => ({ file: name, ...JSON.parse(line) }))));
};
const blob = (path: string) => spawnSync("git", ["hash-object", path], { encoding: "utf8" }).stdout.trim();

async function writeIn(id: string, ref?: unknown): Promise<string> {
  const code = `import os, subprocess, sys
from pathlib import Path
Path("src/${id}-kernel.ts").write_text("export const a = 1;\\n")
subprocess.run([sys.executable, "-c", "open('src/${id}-child.py', 'w').write('x = 1\\\\n')"], check=True)
print(os.environ.get("PI_HOST_SESSION_ID"))`;
  const { harness, root } = await openThread(join(dir, "threads", `${id}.sqlite`), id, rlm, ({ messages }) => {
    if (lastText(messages) === "write") return cell(code);
    return say("done");
  }, checkout);
  if (ref) await harness.commit(async tx => { (await tx.doc(ChatDoc, ROOT_CONVERSATION_ID, "agent.ref", null)).value = ref as never; }, context);
  await (await root.submit({ type: "input", content: "write" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread(id, "idle");
  assert.ok(out[0] && !out[0].isError, out[0]?.text);
  return out[0]!.text.trim();
}

test("an agent thread's kernel and a Python it starts journal their checkout writes under the thread's session id", async () => {
  const id = "4a6b2a3e-0000-4000-8000-00000000vent";
  assert.equal(await writeIn(id, { agent: "ag_vent", dir: join(dir, "agents", "vent"), role: "work" }), id);
  const mine = journal().filter(r => r.session_id === id).map(r => [r.file, r.path, r.tool, r.blob]).sort();
  assert.deepEqual(mine, [
    [`${id}.jsonl`, `src/${id}-child.py`, "prime-kernel", blob(join(checkout, `src/${id}-child.py`))],
    [`${id}.jsonl`, `src/${id}-kernel.ts`, "prime-kernel", blob(join(checkout, `src/${id}-kernel.ts`))],
  ]);
});

test("a plain thread's PI_HOST_SESSION_ID is the id its harness dir names, so commit.mjs reads one session from the kernel's env", async () => {
  const id = "plain-journal";
  assert.equal(await writeIn(id), id);
  assert.deepEqual(journal().filter(r => r.session_id === id).map(r => r.path).sort(), [`src/${id}-child.py`, `src/${id}-kernel.ts`]);
});
