import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The trajectory text the planner and the review gate read, in Prime's `vI` format, and Prime's `$Fn` fit to the model's window. */

const TOOL_RESULT_MAX = 2000;
const TAIL = 500;
const OVERHEAD = 1024;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `[... ${text.length} characters truncated; first ${max} and last ${TAIL} kept ...]`.length;
  const head = max - TAIL - marker - 4;
  const cut = text.length - head - TAIL;
  return `${text.slice(0, head)}\n\n[... ${cut} characters truncated; first ${head} and last ${TAIL} kept ...]\n\n${text.slice(text.length - TAIL)}`;
}

type Block = { type: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };

/** Serializes context messages, after dropping the `skip` custom types, as `[User]:`, `[Assistant]:` and `[Tool result (...)]:` lines. */
export function conversationText(messages: AgentMessage[], skip: ReadonlySet<string> = new Set()): string {
  const kept = messages.filter(m => !(m.role === "custom" && skip.has((m as { customType: string }).customType)));
  const out: string[] = [];
  const callNumbers = new Map<string, number>();
  let calls = 0;
  for (const message of convertToLlm(kept)) {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : (message.content as Block[]).filter(c => c.type === "text").map(c => c.text).join("");
      if (text) out.push(`[User]: ${text}`);
    } else if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of message.content as Block[]) {
        if (block.type === "text" && block.text) texts.push(block.text);
        else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
          calls += 1;
          if (block.id) callNumbers.set(block.id, calls);
          toolCalls.push(`#${calls} ${block.name}(${args})`);
        }
      }
      if (texts.length > 0) out.push(`[Assistant]: ${texts.join("\n")}`);
      if (toolCalls.length > 0) out.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const text = (message.content as Block[]).filter(c => c.type === "text").map(c => c.text).join("");
      if (!text) continue;
      const n = callNumbers.get(message.toolCallId);
      const label = message.isError ? `[Tool result (${message.toolName}, error)${n === undefined ? "" : ` #${n}`}]` : `[Tool result (${message.toolName})${n === undefined ? "" : ` #${n}`}]`;
      out.push(`${label}: ${clip(text, TOOL_RESULT_MAX)}`);
    }
  }
  return out.join("\n\n");
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Fits one prompt to the model: when the system prompt plus the built prompt would pass the window less the output reserve, it keeps the
 * longest tail of `conversation` that fits, and it returns the output budget left. One byte counts as one token, which overestimates.
 */
export function fitPrompt(model: Model<Api>, systemPrompt: string, conversation: string, build: (conversation: string) => string, outputReserve: number) {
  const fixed = bytes(systemPrompt) + OVERHEAD;
  const limit = model.contextWindow - Math.min(model.maxTokens, outputReserve, Math.floor(model.contextWindow / 2));
  let prompt = build(conversation);
  if (fixed + bytes(prompt) > limit && conversation.length > 0) {
    const tail = (n: number) => {
      let start = conversation.length - n;
      const code = conversation.charCodeAt(start);
      if (code >= 0xdc00 && code <= 0xdfff) start++;
      return build(`[Earlier conversation omitted to fit the model context.]\n${conversation.slice(start)}`);
    };
    let lo = 0, hi = conversation.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fixed + bytes(tail(mid)) <= limit) lo = mid;
      else hi = mid - 1;
    }
    prompt = tail(lo);
  }
  const maxTokens = Math.min(model.maxTokens, model.contextWindow - fixed - bytes(prompt));
  if (maxTokens <= 0) throw new Error("Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.");
  return { prompt, maxTokens };
}
