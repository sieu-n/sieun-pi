/** Kills every `chat-service-cli.mjs serve` started under `directory` when the test calls stop() or its process ends. */
export function reapServeOnExit(directory: string): { pid: number | undefined; stop(): Promise<number[]> };
