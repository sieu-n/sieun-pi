/**
 * The per-session handler table for kernel `host_request` methods.
 *
 * pi-rlm owns the Python kernel and its stdio bridge. Other extensions answer some of the kernel's typed requests, such as
 * pi-agent-bus for `agent_message.*` and `agent_observe.*` and pi-harness for `refine.*`. Each one registers its handlers for the
 * session it is loaded into, and pi-rlm looks a method up here before it falls back to its own handlers.
 *
 * Like `registry.ts`, the table lives on `globalThis` under one symbol, so every extension loader in one Node process sees the same table.
 */

export type KernelPayload = Record<string, unknown>;

/** Answers one kernel request. The return value becomes `{status:"ok", result}`, and a throw becomes `{status:"error", error}`. */
export type KernelHandler = (payload: KernelPayload) => unknown | Promise<unknown>;

type Table = Map<string, Map<string, KernelHandler>>;

const KEY = Symbol.for("sieun-pi.pi-stack.kernel-bridge");

function table(): Table {
  const g = globalThis as unknown as Record<symbol, Table | undefined>;
  return (g[KEY] ??= new Map());
}

/** Registers `handler` for `method` in one session and returns a function that removes it. A later registration replaces an earlier one. */
export function registerKernelHandler(sessionId: string, method: string, handler: KernelHandler): () => void {
  const t = table();
  let methods = t.get(sessionId);
  if (!methods) t.set(sessionId, (methods = new Map()));
  methods.set(method, handler);
  return () => {
    const current = t.get(sessionId);
    if (current?.get(method) !== handler) return;
    current.delete(method);
    if (current.size === 0) t.delete(sessionId);
  };
}

export function kernelHandler(sessionId: string, method: string): KernelHandler | undefined {
  return table().get(sessionId)?.get(method);
}

export function kernelMethods(sessionId: string): string[] {
  return [...(table().get(sessionId)?.keys() ?? [])];
}

/** Drops every handler of one session. pi-rlm calls it when the session shuts down. */
export function dropKernelHandlers(sessionId: string): void {
  table().delete(sessionId);
}
