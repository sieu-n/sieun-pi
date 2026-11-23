/**
 * Once pi-host is stopping, no thread starts a new model request or tool call: each one waits until the close stops it, and the next
 * pi-host starts it from the top.
 *
 * On SIGTERM `DurableThreads.shutdown` frees every thread's kernels, which takes 8 to 11 s, before it closes the thread's Harness, and the
 * Harness runs on meanwhile. Over the 21 restarts of 11-23 (15:23 to 22:21Z, ~/work/tokens-slow-parallel/restarts.md) threads started 86 model
 * requests in that window that the close cut mid-stream and sent again, and 73 tool calls, almost all ipython, that met a dying kernel
 * ("Python kernel relay connection closed." or "interrupted and may have partially run"), so the model ran them again.
 *
 * A request held here has sent nothing, so the close leaves no cut answer to pay twice. A tool call held here has no intent yet (pi-durable
 * records intent after `beforeTool`), so the next pi-host runs it once instead of reporting it interrupted. Requests and calls already
 * running at SIGTERM go on as before.
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, GenerationTask, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";

/** Resolves never: rejects with the close's abort, which pi-durable takes as the end of the invocation and writes back no result. */
function untilClosed(context: Context): Promise<never> {
  const signal = context.abortSignal;
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The hooks that hold each new request and tool call while `stopping()` says pi-host is stopping. */
export function drainGate(stopping: () => boolean): Extension {
  return defineExtension({
    name: "drain-gate",
    hooks: [
      hook(GenerationTask, { beforeRequest: async (_request, _api, context) => (stopping() && context.abortSignal ? untilClosed(context) : undefined) }),
      hook(ToolTask, { beforeTool: async (_call, _api, context) => (stopping() && context.abortSignal ? untilClosed(context) : undefined) }),
    ],
  });
}
