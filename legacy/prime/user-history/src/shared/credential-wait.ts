/**
 * Prime's credential wait marker. When the token hook answers that no account is free until a time (exit 75), dhx.3 Prime writes an
 * assistant entry with stopReason "error", no content and one provider_stream_failure diagnostic whose details hold kind
 * "credential_unavailable" and retryAtMs, and sleeps until then. Its text names no pi-pool slot, so on 10-20 the readers of pi-pool's "this
 * session waits for its slot at" read the 15 sessions the idle unload stopped in such a wait on us-metal02 as failed or not at all, and
 * none got its continue.
 */
export function credentialWaitAt(message: { diagnostics?: unknown }): number | null {
  if (!Array.isArray(message.diagnostics)) return null;
  for (const diagnostic of message.diagnostics as unknown[]) {
    const details = typeof diagnostic === "object" && diagnostic !== null ? (diagnostic as { details?: unknown }).details : undefined;
    if (typeof details !== "object" || details === null) continue;
    const { kind, retryAtMs } = details as { kind?: unknown; retryAtMs?: unknown };
    if (kind === "credential_unavailable" && typeof retryAtMs === "number" && Number.isFinite(retryAtMs)) return retryAtMs;
  }
  return null;
}

/** The error a failed assistant turn ended on: its errorMessage, with a credential wait marker read as the token hook's slot wait at its retryAtMs. */
export function turnError(message: { errorMessage?: unknown; diagnostics?: unknown }): string | undefined {
  const at = credentialWaitAt(message);
  if (at !== null) return `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at ${new Date(at).toISOString()}.`;
  return typeof message.errorMessage === "string" ? message.errorMessage : undefined;
}
