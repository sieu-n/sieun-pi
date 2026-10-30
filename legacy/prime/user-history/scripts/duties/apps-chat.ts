/**
 * The new chat (apps/chat on :5184, or `PI_HOST_CHAT_URL` in a pi-host thread's kernel) keeps the duties of its agents and threads in its own
 * data dir, `<data dir>/agents/<agent id>/duties.json`, and changes them through `POST /api/agents/:id/duties`. add.ts and remove.ts send a
 * duty there when that chat answers `GET /api/agents/<id>/config` for the id, and write Prime's store for any other chat.
 */
const BASE = (process.env.PI_HOST_CHAT_URL || "http://127.0.0.1:5184").replace(/\/+$/, "");

/** The duties URL of a chat the new chat holds, or null for a Prime chat (a 404) or when the new chat does not answer. */
export async function appsChatDuties(chatId: string): Promise<string | null> {
  const agent = `${BASE}/api/agents/${encodeURIComponent(chatId)}`;
  try {
    const response = await fetch(`${agent}/config`, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? `${agent}/duties` : null;
  } catch {
    return null;
  }
}

export interface AppsChatDuty { duty: { id: string; name: string }; schedule: { kind: "daily"; at: string } | { kind: "every"; minutes: number } }

/** One duties call; a refusal throws with the server's own error text. */
export async function dutiesCall(url: string, body?: unknown): Promise<{ duties: AppsChatDuty[]; result?: string }> {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => ({})) as { duties?: AppsChatDuty[]; result?: string; error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `${url} answered ${response.status}`);
  return { duties: parsed.duties ?? [], ...(parsed.result ? { result: parsed.result } : {}) };
}
