import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { PROMPT_KINDS, type PromptKind, parsePrompts, promptsText, signInPromptsFile, withPrompt } from "../src/sign-in-prompts.ts";

/**
 * Records that an agent's sign-in of a pool account reached a password, 2FA, passkey or payment prompt. The first three make the account the
 * owner's fix in d5's pool checks, and a payment prompt reads it as off for an unpaid plan (src/sign-in-prompts.ts):
 * `node --import tsx scripts/sign-in-prompt.ts <email> --provider anthropic --prompt passkey --where "<page that asked>" --evidence <screenshot or session ref> [--at <ISO>]`.
 * Run it only after a real attempt showed the prompt, with --at set to when it did; the account's earlier record is replaced.
 */
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  provider: { type: "string", default: "anthropic" }, prompt: { type: "string" }, where: { type: "string" }, evidence: { type: "string" }, at: { type: "string" } } });
const fail = (text: string): never => { process.stderr.write(`sign-in-prompt: ${text}\n`); process.exit(2); };
const account = positionals[0] ?? fail("name the account's email");
const prompt = (PROMPT_KINDS as readonly string[]).includes(values.prompt ?? "") ? values.prompt as PromptKind : fail(`--prompt is one of ${PROMPT_KINDS.join(", ")}`);
const at = values.at ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(at))) fail(`--at ${at} is no time`);
const file = signInPromptsFile();
const before = parsePrompts(await readFile(file, "utf8").catch(() => undefined));
const record = { provider: values.provider!, account, prompt, at: new Date(at).toISOString(), where: values.where ?? fail("--where names the page that asked"),
  evidence: values.evidence ?? fail("--evidence names a screenshot or session ref that shows the prompt") };
await mkdir(dirname(file), { recursive: true });
await writeFile(`${file}.tmp`, promptsText(withPrompt(before, record)));
await rename(`${file}.tmp`, file);
process.stdout.write(`${file}: ${record.account} (${record.provider}) reached a ${record.prompt} prompt at ${record.at}\n`);
