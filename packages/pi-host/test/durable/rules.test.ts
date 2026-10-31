/**
 * p1331 (11-01): durable pi-host threads ran none of sieun-rules' tool_call handlers, so a durable agent had no send guard (c37), no
 * auto-sns-agent repo guard and no transcript guard, and its kernel never loaded the prelude. `rules.ts` runs the handlers around every
 * durable tool call, and `rlm.ts` starts each cell with the kernel prelude, as Prime does.
 */
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { threadRegistry, threadEnv } from "../../src/durable/registry.ts";
import { DurableRlm, type RlmThread } from "../../src/durable/rlm.ts";
import { DurableRules } from "../../src/durable/rules.ts";
import { MODEL } from "./crash-scenario.ts";
import { call, cell, context, entriesOf, lastText, results, rlmOptions, say } from "./rlm-rig.ts";

const CHECKOUT = join(homedir(), "Documents/Github/auto-sns-agent");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-rules-")));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "threads"));
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.GLOBAL_RULES_LOG = join(dir, "global-rules.log");
process.env.AGENT_CHAT_DATA_DIR = join(dir, "chat");
process.env.GLOBAL_RULES_AUTO_SNS_AGENT = CHECKOUT;
for (const key of ["GLOBAL_RULES", "GLOBAL_RULES_GUARD", "OWNER_OK", "RLM_SESSION_DIR"]) delete process.env[key];

// Another chat's transcript under the agent dir, which no durable thread's family holds.
const OTHER = "01a10000-0000-7000-8000-00000000beef";
const transcript = join(dir, "agent", "sessions", `${OTHER}.jsonl`);
mkdirSync(join(dir, "agent", "sessions"), { recursive: true });
writeFileSync(transcript, '{"type":"session","id":"secret"}\n');
const SEND = "false && curl -X POST https://api.sendgrid.com/v3/mail/send -d x";

let rlm: DurableRlm;
let rules: DurableRules;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
  rules = await DurableRules.load();
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

async function run(id: string, steps: ((last: string) => ReturnType<typeof say> | undefined)[]) {
  let harness: Harness | undefined;
  const file = join(dir, "threads", `${id}.sqlite`);
  const thread: RlmThread = { id, file, name: () => `thread ${id}`, cwd: dir, harness: () => harness };
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let step = 0;
  faux.setResponses(Array.from({ length: 50 }, () => ({ messages }: { messages: never[] }) => steps[step++]?.(lastText(messages)) ?? say("done")));
  models.setProvider(faux.provider);
  const registry = threadRegistry(undefined, undefined, { thread: { id, file }, rlm: rlm.extension(thread), rules: rules.extension({ id, file, name: thread.name, cwd: () => dir }) });
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry, env: threadEnv(() => dir) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", cwd: dir } });
  harness.resume();
  await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread(id, "idle");
  return out;
}

test("the send guard refuses a bash call and an ipython cell that write to a mail API, and the kernel loads the run-time send guard", async () => {
  const out = await run("4a6b2a3e-0000-4000-8000-0000000000a1", [
    () => call("bash", { command: SEND }),
    () => cell(`import subprocess\nsubprocess.run(${JSON.stringify(SEND)}, shell=True)`),
    () => cell("import sys\nprint(sys.global_rules_send_guard, sys.global_rules_kernel_journal, sys.global_rules_kernel_read)"),
  ]);
  assert.equal(out.length, 3);
  for (const refused of out.slice(0, 2)) {
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /send guard: refused, because this curl call writes to the mail API api\.sendgrid\.com/);
  }
  assert.equal(out[2]!.text.trim(), "True True True");
});

test("the transcript guard refuses a read tool call and a kernel open() of another chat's transcript", async () => {
  const out = await run("4a6b2a3e-0000-4000-8000-0000000000a2", [
    () => call("read", { path: transcript }),
    () => cell(`try:\n    open(${JSON.stringify(transcript)}).read()\n    print("read it")\nexcept TranscriptRefused as error:\n    print("refused", error)`),
  ]);
  assert.equal(out[0]!.isError, true, out[0]!.text);
  assert.match(out[0]!.text, new RegExp(`global-rules refused reading ${transcript.replace(/[.]/g, "\\.")}: it is the transcript of session ${OTHER}`));
  assert.match(out[1]!.text, /^refused global-rules refused reading/);
});

test("the auto-sns-agent repo guard refuses a git stash in its shared checkout", { skip: !existsSync(join(CHECKOUT, ".git")) && "no auto-sns-agent checkout on this box" }, async () => {
  const out = await run("4a6b2a3e-0000-4000-8000-0000000000a3", [() => call("bash", { command: `cd ${CHECKOUT} && false && git stash` })]);
  assert.equal(out[0]!.isError, true, out[0]!.text);
  assert.match(out[0]!.text, /repo guard \(git-hazard\): `git stash`/);
});
