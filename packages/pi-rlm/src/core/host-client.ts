import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { hostApi, HOST_SOCKET_ENV } from "@sieun-pi/pi-family/host-api";

export interface CreateSessionRequest {
  prompt: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
}

export interface CreateSessionHandle {
  active_session_id: string;
  session_id: string;
  name: string;
  session_file: string;
  model: string;
}

/** Sends commands to pi-host's socket one at a time and resolves each with its response's data. */
async function socketCall(path: string, commands: Record<string, unknown>[]): Promise<unknown[]> {
  const socket = createConnection(path);
  const lines = createInterface({ input: socket });
  const queue: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  lines.on("line", line => {
    try {
      queue.push(JSON.parse(line));
    } catch {}
    wake?.();
  });
  const failed = new Promise<never>((_, reject) => socket.once("error", reject));
  const next = async (match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (;;) {
      const i = queue.findIndex(match);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      await Promise.race([new Promise<void>(r => (wake = r)), failed]);
    }
  };
  try {
    await next(m => m.type === "daemon_hello");
    const out: unknown[] = [];
    for (const [i, command] of commands.entries()) {
      const id = `rlm-${process.pid}-${Date.now()}-${i}`;
      socket.write(JSON.stringify({ ...command, id }) + "\n");
      const reply = await next(m => m.type === "response" && m.id === id);
      if (reply.success !== true) throw new Error(`pi-host ${String(command.type)} failed: ${String(reply.error)}`);
      out.push(reply.data);
      if (i === 0 && commands.length > 1) {
        const data = reply.data as { activeSessionId?: string };
        for (const later of commands.slice(1)) if (later.activeSessionId === "$created") later.activeSessionId = data.activeSessionId;
      }
    }
    return out;
  } finally {
    lines.close();
    socket.destroy();
  }
}

function modelName(model: unknown): string {
  if (typeof model === "string") return model;
  const m = model as { provider?: string; id?: string } | undefined;
  return m?.provider && m.id ? `${m.provider}/${m.id}` : "unknown";
}

/** `rlm.create_session`: a resident depth-0 session in pi-host, reached in-process when this session runs inside pi-host, else over `PI_HOST_SOCKET`. */
export async function createSession(request: CreateSessionRequest): Promise<CreateSessionHandle> {
  const api = hostApi();
  if (api) {
    const info = await api.open({
      cwd: request.cwd,
      name: request.name,
      provider: request.provider,
      model: request.model,
      thinking: request.thinking as never,
    });
    const runtime = api.runtime(info.sessionId);
    if (!runtime) throw new Error("pi-host opened the session but has no runtime for it");
    void runtime.session.prompt(request.prompt).catch(() => {});
    const m = runtime.session.model;
    return {
      active_session_id: info.sessionId,
      session_id: info.sessionId,
      name: info.name ?? request.name ?? info.sessionId,
      session_file: info.sessionFile ?? "",
      model: m ? `${m.provider}/${m.id}` : "unknown",
    };
  }
  const path = process.env[HOST_SOCKET_ENV];
  if (!path) throw new Error("rlm.create_session needs pi-host: run this session inside pi-host or set PI_HOST_SOCKET");
  const [created] = await socketCall(path, [
    { type: "create", name: request.name, lifecycle: "resident", config: { cwd: request.cwd, provider: request.provider, model: request.model, thinking: request.thinking } },
    { type: "prompt", activeSessionId: "$created", message: request.prompt },
  ]);
  const data = created as { activeSessionId: string; sessionId: string; sessionFile?: string; sessionName?: string; model?: unknown };
  return {
    active_session_id: data.activeSessionId,
    session_id: data.sessionId,
    name: data.sessionName ?? request.name ?? data.sessionId,
    session_file: data.sessionFile ?? "",
    model: modelName(data.model),
  };
}
