/**
 * Builds an agent's prompts with the code of a pi-host tree, in a process of its own: `agent-prompt.ts` starts it with node and tsx in that
 * tree's `packages` folder, so each import resolves to the modules that tree runs with. It reads one request as JSON on stdin and writes the
 * answer as JSON on stdout.
 *
 *   node --import tsx <this file> <pi-host tree> < request.json
 *
 * The prompt of each conversation comes from pi-host's own builder: `conversationPromptInput` and `primePromptParts` in
 * packages/pi-host/src/durable/prime-prompt.ts, which every pi-host request renders from, and the role text from `roleFields` in agent-profile.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptChildRequest, PromptChildAnswer } from "./agent-prompt.ts";

interface Skill { name: string; description?: string; filePath: string; disableModelInvocation?: boolean }
interface PromptModule {
  conversationPromptInput(options: { agentDir: string; tools?: string }, at: Record<string, unknown>): { cwd: string };
  primePromptParts(input: unknown): Promise<{ key: string; text: string; source: string }[]>;
  primeResources(agentDir: string, cwd: string, bundled: string): Promise<{ skills: Skill[] }>;
  bundledSkillsDir(): string;
  promptTools(): string;
}
interface ProfileModule {
  parseAgentRef(value: unknown): unknown;
  roleFields(ref: unknown): { instructions?: string };
  agentName(ref: unknown): string;
  workingMemoryPath?(ref: unknown): string;
}
interface WorkingModule {
  workingMemoryText(agent: string, path: string, text: unknown): string | undefined;
  workingMemoryPath?(ref: unknown): string;
  readWorkingMemory(ref: unknown): unknown;
}

const root = process.argv[2];
if (!root) throw new Error("usage: agent-prompt-child.ts <pi-host tree>");
const durable = join(root, "packages/pi-host/src/durable");
const prompt = await import(pathToFileURL(join(durable, "prime-prompt.ts")).href) as PromptModule;
const profile = await import(pathToFileURL(join(durable, "agent-profile.ts")).href) as ProfileModule;
if (typeof prompt.conversationPromptInput !== "function") throw new Error(`${durable}/prime-prompt.ts has no conversationPromptInput; that pi-host is older than the Prompt tab`);
// The agent's working memory file, which registry.ts installs as the last extension: its `working` section follows `writing`.
const working = existsSync(join(durable, "working-memory.ts")) ? await import(pathToFileURL(join(durable, "working-memory.ts")).href) as WorkingModule : undefined;

const request = JSON.parse(readFileSync(0, "utf8")) as PromptChildRequest;
const options = { agentDir: request.agentDir, tools: prompt.promptTools() };
const answer: PromptChildAnswer = { kinds: [], skills: [] };
for (const at of request.conversations) {
  const ref = at.agent === undefined ? undefined : profile.parseAgentRef(at.agent);
  const input = prompt.conversationPromptInput(options, { ...at, ...(ref ? { agent: ref } : {}), rootDigest: true });
  const parts = await prompt.primePromptParts(input);
  const memory = ref && working?.workingMemoryText(profile.agentName(ref), (profile.workingMemoryPath ?? working.workingMemoryPath)!(ref), working.readWorkingMemory(ref));
  if (memory) parts.push({ key: "working", text: memory, source: "working-memory.ts workingMemoryText: the agent's working-memory.md" });
  const instructions = at.conversationId === 1 ? profile.roleFields(ref).instructions : undefined;
  if (instructions) parts.push({ key: "instructions", text: instructions, source: "agent-profile.ts roleFields: the role text of the thread's agent.ref" });
  answer.kinds.push({ kind: at.kind, parts });
  if (answer.skills.length === 0) {
    const { skills } = await prompt.primeResources(request.agentDir, input.cwd, prompt.bundledSkillsDir());
    answer.skills = skills.filter(skill => !skill.disableModelInvocation).map(skill => ({ name: skill.name, description: skill.description ?? "", path: skill.filePath }));
  }
}
// The digest worker that primePromptParts starts keeps the process alive, so it exits once stdout, a pipe, has taken the whole answer.
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
