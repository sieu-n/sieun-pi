/**
 * Keeps one bad session from ending the host. Research probe P6 showed that a throw in one extension's timer kills a bare Node host and every
 * session in it, while `process.on("uncaughtException")` kept the other session answering. The guard logs each fault and records it on the
 * host, so a test or the roster can see it.
 */

import type { PiHost } from "./host.ts";

export function installGuard(host: PiHost): () => void {
  const record = (kind: string) => (error: unknown) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    host.faults.push({ kind, message, at: new Date().toISOString() });
    if (host.faults.length > 200) host.faults.splice(0, host.faults.length - 200);
    host.log(`${kind} kept the host up: ${message.split("\n")[0]}`);
  };
  const onException = record("uncaughtException");
  const onRejection = record("unhandledRejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
