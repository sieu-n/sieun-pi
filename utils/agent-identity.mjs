import path from "node:path";

export function detectAgentIdentity(env = process.env) {
  if (env.PI_CODING_AGENT || env.PRIME_AGENT_CODING_AGENT_DIR || env.RLM_SESSION_DIR) {
    const sessionId = env.RLM_SESSION_DIR
      ? path.basename(env.RLM_SESSION_DIR)
      : env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID ?? null;
    return { agentId: "prime-agent", sessionId };
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) {
    return { agentId: "codex", sessionId: env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID };
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
    return { agentId: "claude", sessionId: env.CLAUDE_SESSION_ID ?? null };
  }
  return { agentId: "unknown", sessionId: null };
}
