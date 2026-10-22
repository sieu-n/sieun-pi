import { DUTY_BRIEF, type PromptApi, type PromptPart, type PromptView } from "../shared/prompt-view.ts";

/**
 * The prompt rebuilt in the order the provider reads it, for debugging the harness: the parts before the conversation by where each comes from,
 * then the conversation as one row per incoming message with the model's work after it nested under it. Pure, so the Prompt dialog renders it and
 * test/prompt-order.test.ts checks it.
 */

/**
 * A row before the conversation. `part` is the payload part it shows; a placeholder has none and names what a rebuild cannot know; a group (the
 * tool definitions, the skills list) opens into `children`.
 */
export type HeadRow = { key: string; label: string; source: string; tokens: number; part?: PromptPart; text?: string; placeholder?: true; children?: HeadRow[] };
export type HeadSection = { key: string; title: string; tokens: number; rows: HeadRow[] };

/** A step of the model's work in a turn: a thinking, text or tool call block; a call holds its results, matched by tool call id. */
export type Step = { part: PromptPart; results: PromptPart[] };

/**
 * One incoming message and what follows it until the next one. `lead` is the message's text (or its first block); `added` holds the other blocks
 * of the same payload message: images and the blocks the context hook adds. `midTurn` marks a message that arrived while the model was in a tool
 * loop (the block before it was a tool result). A turn with no lead holds model work before any incoming message.
 */
export type Turn = { key: string; lead: PromptPart | null; added: PromptPart[]; steps: Step[]; tokens: number; midTurn: boolean; at?: string };

export type PromptOrderTree = { api: PromptApi | undefined; head: HeadSection[]; headTokens: number; turns: Turn[]; turnTokens: number; partCount: number };

const sum = (values: readonly { tokens: number }[]): number => values.reduce((total, value) => total + value.tokens, 0);
const estimate = (text: string): number => Math.ceil(text.length / 4);

export const REGISTRAR: Record<NonNullable<PromptPart["registeredBy"]>, string> = {
  "user-history": "user-history extension (extension/index.ts)",
  prime: "Prime built-in tool",
  other: "another extension",
};

/** The skills list as one row per `<skill>` with its name and location; the text around the skills is the first row. */
export function skillRows(part: PromptPart): HeadRow[] {
  const skills = [...part.text.matchAll(/^[ \t]*<skill>[\s\S]*?<\/skill>[ \t]*\n?/gm)];
  if (!skills.length) return [];
  const rows: HeadRow[] = skills.map((match, index) => {
    const block = match[0];
    const name = /<name>([^<]*)<\/name>/.exec(block)?.[1]?.trim() || `skill ${index + 1}`;
    const location = /<location>([^<]*)<\/location>/.exec(block)?.[1]?.trim() ?? "";
    const kind = /<type>([^<]*)<\/type>/.exec(block)?.[1]?.trim();
    return { key: `${part.id}:skill:${index}`, label: name, source: [kind ? `${kind} skill` : "skill", location].filter(Boolean).join(", "), tokens: estimate(block), text: block };
  });
  const frame = part.text.slice(0, skills[0]!.index) + part.text.slice(skills.at(-1)!.index! + skills.at(-1)![0].length);
  rows.unshift({ key: `${part.id}:skill:frame`, label: "Skills list frame", source: "the lines around the skills", tokens: Math.max(0, part.tokens - sum(rows)), text: frame });
  return rows;
}

const PLACEHOLDER = "not in the session file, so a rebuild cannot show it";

function headRow(part: PromptPart): HeadRow {
  const skills = part.kind === "skills" ? skillRows(part) : [];
  return { key: part.id, label: part.label, source: part.source, tokens: part.tokens, part, ...(skills.length ? { children: skills } : {}) };
}

/**
 * The parts before the conversation as the provider reads them: Anthropic reads the tool definitions before the system blocks, OpenAI Responses
 * the instructions before the tools. A rebuild holds only the project context files and the chat brief, so the sections it cannot know are
 * placeholders at their place in Prime's system prompt (base prompt, MCP and tool guidelines, then the guidance it holds, project context, skills list).
 */
function headSections(view: PromptView): HeadSection[] {
  const head = view.parts.filter(part => !part.role);
  const tools = head.filter(part => part.kind === "tools").map((part): HeadRow => ({ key: part.id, label: part.label.replace(/^Tool: /, ""),
    source: part.registeredBy ? REGISTRAR[part.registeredBy] : "tool definition", tokens: part.tokens, part }));
  let system = head.filter(part => part.kind !== "tools").map(headRow);
  const rebuilt = view.origin.kind === "rebuild";
  if (rebuilt) {
    const hole = (key: string, label: string, source: string): HeadRow => ({ key: "missing:" + key, label, source: `${source}; ${PLACEHOLDER}`, tokens: 0, placeholder: true });
    const guidance = system.filter(row => row.part?.label === "Chat brief" || row.part?.label === "Job report line");
    const rest = system.filter(row => !guidance.includes(row));
    system = [hole("base", "Base system prompt", "Prime buildRlmPrompt and buildSubagentGuidance"), hole("mcp", "MCP connections and tool guidelines", "Prime: enabled MCP servers and promptGuidelines of the active tools"),
      ...guidance, ...rest, hole("skills", "Skills list", "Prime formatSkillsForPrompt")];
  }
  const toolRows: HeadRow[] = tools.length ? tools : rebuilt ? [{ key: "missing:tools", label: "Every tool definition", source: `Prime's tools and each extension's; ${PLACEHOLDER}`, tokens: 0, placeholder: true }] : [];
  const sections: HeadSection[] = [];
  const toolSection = toolRows.length ? { key: "s:tools", title: tools.length ? `Tool definitions, ${tools.length}` : "Tool definitions", tokens: sum(toolRows), rows: toolRows } : null;
  const systemSection = system.length ? { key: "s:system", title: view.api === "openai-responses" ? "Instructions" : "System prompt", tokens: sum(system), rows: system } : null;
  if (view.api === "openai-responses" || view.api === "openai-completions") { if (systemSection) sections.push(systemSection); if (toolSection) sections.push(toolSection); }
  else { if (toolSection) sections.push(toolSection); if (systemSection) sections.push(systemSection); }
  return sections;
}

/** True for an incoming text the context hook did not add: it opens a top-level row even inside a message that already opened one. */
const incoming = (part: PromptPart): boolean => part.role === "user" && !part.hook && part.label !== "Image";

/**
 * The conversation as turns. Each incoming message opens a turn, led by its first text (an image or a hook block when it has none), and each
 * further incoming text opens one too, such as a compaction summary that rides in the digest's message. The images and hook blocks of the
 * lead's message join it; the model's blocks after it are its steps, and each tool result goes under the call with its id (under the last step
 * when no call matches).
 */
export function turnsOf(parts: readonly PromptPart[]): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, Step>();
  let current: Turn | null = null;
  let last: PromptPart | null = null;
  const open = (lead: PromptPart | null): Turn => {
    const turn: Turn = { key: "t:" + (lead?.id ?? "start"), lead, added: [], steps: [], tokens: 0, midTurn: last?.role === "toolResult", ...(lead?.at ? { at: lead.at } : {}) };
    turns.push(turn);
    return turn;
  };
  for (const part of parts) {
    if (!part.role) continue;
    if (part.role === "user") {
      const same = current?.lead?.message !== undefined && current.lead.message === part.message && !current.steps.length;
      if (same && incoming(part) && !incoming(current!.lead!)) {
        current!.added.unshift(current!.lead!);
        current!.lead = part;
        current!.key = "t:" + part.id;
        if (part.at) current!.at = part.at;
      } else if (same && !incoming(part)) current!.added.push(part);
      else current = open(part);
    } else {
      current ??= open(null);
      if (part.role === "toolResult") {
        const step = (part.call && calls.get(part.call)) || current.steps.at(-1);
        if (step) step.results.push(part);
        else current.steps.push({ part, results: [] });
      } else {
        const step: Step = { part, results: [] };
        current.steps.push(step);
        if (part.call) calls.set(part.call, step);
      }
    }
    current!.tokens += part.tokens;
    last = part;
  }
  return turns;
}

export function orderTree(view: PromptView): PromptOrderTree {
  const head = headSections(view);
  const turns = turnsOf(view.parts);
  return { api: view.api, head, headTokens: sum(head), turns, turnTokens: sum(turns), partCount: view.parts.length };
}

/** The turn a duty job's brief opens, which the view opens on load; null for any other session. */
export const briefTurn = (tree: PromptOrderTree): Turn | null => tree.turns.find(turn => turn.lead?.label === DUTY_BRIEF) ?? null;

export const turnLabel = (turn: Turn): string => turn.lead?.label ?? "Before the first message";

/** A step's label in its turn: "Thinking", "Text", or "→ <tool>" for a tool call. */
export function stepLabel(part: PromptPart): string {
  if (part.label === "Assistant thinking") return "Thinking";
  if (part.label === "Assistant") return "Text";
  const tool = /^Assistant tool call: (.+)$/.exec(part.label)?.[1];
  return tool ? `→ ${tool}` : part.label;
}

/** A part's time on its row: the time of day today, else the date and time. The formats are built once: toLocaleTimeString builds one per call, 170 ms over 458 rows. */
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
export function when(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = TIME.format(date);
  return date.toDateString() === now.toDateString() ? time : DAY.format(date) + " " + time;
}

/** How the provider reads the request, for the line above the view. */
export const API_ORDER: Record<PromptApi, string> = {
  "anthropic-messages": "An Anthropic Messages request reads the tool definitions, then the system prompt, then the messages.",
  "openai-responses": "An OpenAI Responses request reads the instructions, then the tool definitions, then the input.",
  "openai-completions": "An OpenAI Chat Completions request reads the system messages, then the tool definitions, then the messages.",
};
