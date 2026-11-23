/**
 * A compaction summary gets the model's whole output limit, and a summary that still runs out of room is asked once for a shorter one.
 *
 * pi-durable's compaction (`CompactionTask`) asks for at most 0.8 x `reserveTokens` output tokens, 13,107 at Prime's reserve of 16,384,
 * and fails on a summary that ends `length`. The generation that waits for it fails too, and so does every later turn of the thread,
 * because each one starts the same compaction again. With adaptive thinking (Claude Fable 5.2 and Opus 5.5) the thinking and the summary
 * share that one budget. On 11-23 agent factory's work thread failed ten turns in a row this way from 10:17 to 16:00 KST, with summaries
 * that had grown from 10,241 to 25,198 characters. Upstream pi's own compaction gives a summary the model's output limit (pi #9512), and
 * so does this wrapper, which leaves the prompt, the thinking level and pi-durable's retries of transient errors as they are.
 *
 * A summary that ends `length` with the full limit is asked once more, with a line after Prime's prompt asking for half the length. When
 * that one ends `length` too, its text is placed as it stands with a closing line saying where it stops: a cut summary loses its last
 * sections, and a failed one stops the thread until someone finds it.
 */
import { createAssistantMessageEventStream, getInitialSystemMessage, type AssistantMessage, type AssistantMessageEvent, type Message, type Provider, type Usage } from "@earendil-works/pi-ai";

/** The first line of pi-durable's summarization system prompt (`SUMMARIZATION_SYSTEM_PROMPT` in its harness/compaction.js). */
export const SUMMARY_SYSTEM_START = "You are a context summarization assistant.";

/** The line the second request adds after the prompt; `tokens` is the output the first summary used. */
export const shorterLine = (tokens: number): string =>
  `Your first summary of this conversation ran past the output limit after ${tokens} tokens. Write the same structured summary in at most half that length: keep every section, and cut detail from Done and Critical Context first.`;

/** The line a summary that ran past the limit twice ends with. */
export const CUT_LINE = "\n[This summary stops here: it reached the model's output limit twice.]";

type Stream = ReturnType<Provider["streamSimple"]>;

const textOf = (content: string | readonly { type: string; text?: string }[]): string =>
  typeof content === "string" ? content : content.flatMap(part => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

/** Whether the request is pi-durable's compaction summary, which opens with its own system prompt. */
export function isSummaryRequest(messages: readonly Message[]): boolean {
  const system = getInitialSystemMessage(messages as Message[]);
  return system !== undefined && textOf(system.content).startsWith(SUMMARY_SYSTEM_START);
}

/** `messages` with `line` as a text part after the last user message's, which ends with Prime's prompt. */
function withLine(messages: readonly Message[], line: string): Message[] {
  const at = messages.findLastIndex(message => message.role === "user");
  return messages.map((message, index) => {
    if (index !== at || message.role !== "user") return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return { ...message, content: [...content, { type: "text" as const, text: line }] };
  });
}

/** `a` plus `b`, field by field, so the usage pi-durable records covers both requests. */
function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x: unknown, y: unknown): unknown => {
    if (typeof x === "number" || typeof y === "number") return (typeof x === "number" ? x : 0) + (typeof y === "number" ? y : 0);
    if (x && y && typeof x === "object" && typeof y === "object") {
      return Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].map(key => [key, sum((x as never)[key], (y as never)[key])]));
    }
    return y ?? x;
  };
  return sum(a, b) as Usage;
}

const cut = (message: AssistantMessage): AssistantMessage => ({ ...message, stopReason: "stop", content: [...message.content, { type: "text", text: CUT_LINE }] });

/** Every event of `stream` and its final message. */
async function drain(stream: Stream): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

/** `inner` with each compaction summary request given the model's output limit and one shorter retry, as described above. */
export function withSummaryRoom(inner: Provider): Provider {
  return {
    ...inner,
    streamSimple: (model, context, options) => {
      if (!isSummaryRequest(context.messages)) return inner.streamSimple(model, context, options);
      const { maxTokens: _maxTokens, ...rest } = options ?? {};
      const out = createAssistantMessageEventStream();
      void (async () => {
        const first = await drain(inner.streamSimple(model, context, rest));
        if (first.message.stopReason !== "length" || rest.signal?.aborted) {
          for (const event of first.events) out.push(event);
          out.end(first.message);
          return;
        }
        const second = await drain(inner.streamSimple(model, { ...context, messages: withLine(context.messages, shorterLine(first.message.usage.output)) }, rest));
        const usage = addUsage(first.message.usage, second.message.usage);
        const message = second.message.stopReason === "length" ? cut({ ...second.message, usage }) : { ...second.message, usage };
        for (const event of second.events) {
          if (event.type === "done") out.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : event.reason, message });
          else if (event.type === "error") out.push({ ...event, error: message });
          else out.push(event);
        }
        out.end(message);
      })().catch(error => {
        const message: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
      });
      return out as Stream;
    },
  };
}
