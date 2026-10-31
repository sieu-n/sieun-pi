/**
 * sieun-rules' tool_call and tool_result handlers (packages/sieun-rules/src/index.ts, the extension every Prime and pi-host Pi session loads)
 * around every tool call of a durable thread, through the adapter in `pi-extensions.ts` (p1331, 11-01). A durable thread runs no pi agent
 * loop, so before p1331 none of them ran: no send guard (c37), no auto-sns-agent repo guard (c193 and the shared-checkout rules) and no
 * transcript guard.
 *
 * 1. `beforeTool` emits pi's `tool_call` event with a copy of the call's arguments and a pi context whose `rlmSessionDir` names the
 *    conversation's kernel folder (`artifactDirOf`), where kernel-cwd.py reports the kernel's cwd. The first `block` refuses the call with its
 *    reason. A handler's edit of the arguments, such as kernel-guard.ts's prelude, is dropped, because `rlm.ts` gives the kernel the prelude
 *    and the thread keeps the call as the model wrote it.
 * 2. `afterTool` emits `tool_result`, and a handler's `content`, such as a repo guard note, replaces the result's output.
 * 3. A handler that throws is logged and skipped, so a guard bug fails open as it does in Prime.
 */
import { defineExtension, hook, ToolTask, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { artifactDirOf, sessionOf } from "./children.ts";
import { loadPiExtension, piContext, type LoadedPiExtension } from "./pi-extensions.ts";

export const RULES_EXTENSION = "sieun-rules";

/** The thread a conversation's tool calls belong to. */
export interface RulesThread {
  id: string;
  file: string;
  name: () => string;
  cwd: () => string;
}

export class DurableRules {
  private constructor(readonly loaded: LoadedPiExtension) {}

  /** Loads sieun-rules' extension once for the host, as Prime loads it once per session. */
  static async load(options: { log?: (line: string) => void } = {}): Promise<DurableRules> {
    const rules = (await import("../../../sieun-rules/src/index.ts")) as { default: (pi: never) => unknown };
    return new DurableRules(await loadPiExtension(rules.default, options.log ? { log: options.log } : {}));
  }

  private context(thread: RulesThread, conversation: number): Record<string, unknown> {
    const session = { id: sessionOf(thread.id, conversation), name: thread.name(), file: thread.file, cwd: thread.cwd() };
    return { ...piContext(session), rlmSessionDir: artifactDirOf(thread.file, thread.id, conversation) };
  }

  /** The hooks one thread's conversations select. */
  extension(thread: RulesThread): Extension {
    return defineExtension({
      name: RULES_EXTENSION,
      hooks: [hook(ToolTask, {
        beforeTool: async (call, api) => {
          const event = { type: "tool_call", toolName: call.name, toolCallId: call.id, input: structuredClone(call.arguments ?? {}) };
          for (const verdict of await this.loaded.emit("tool_call", event, this.context(thread, api.conversationId))) {
            const block = verdict as { block?: boolean; reason?: string } | undefined;
            if (block?.block) return { block: block.reason ?? `sieun-rules refused this ${call.name} call` };
          }
          return undefined;
        },
        afterTool: async (call, result, api) => {
          const event = { type: "tool_result", toolName: call.name, toolCallId: call.id, input: call.arguments ?? {}, content: result.output, isError: result.isError === true };
          let output = result.output;
          for (const changed of await this.loaded.emit("tool_result", { ...event }, this.context(thread, api.conversationId))) {
            const content = (changed as { content?: unknown } | undefined)?.content;
            if (Array.isArray(content)) output = content as ToolExecutionResult["output"];
          }
          return output === result.output ? undefined : { ...result, output };
        },
      })],
    });
  }
}
