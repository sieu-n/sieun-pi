/**
 * Whether this extension runs on upstream Pi (pi-host or a plain pi CLI) rather than Prime Agent 0.9.8. Prime's extension API has no
 * registerMcpServer, and pi-host's unit and the pi-stack rigs also set SIEUN_CHAT_BACKEND=pi-host, which the chat service reads.
 */
export function onUpstreamPi(pi: object, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIEUN_CHAT_BACKEND === "pi-host" || typeof (pi as { registerMcpServer?: unknown }).registerMcpServer === "function";
}
