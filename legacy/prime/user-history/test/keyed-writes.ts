import type { TestContext } from "node:test";
import { DaemonClient } from "prime-agent";
import { DaemonWriter } from "../src/daemon-write.ts";

/** Hands each keyed write (src/daemon-write.ts) to the test's mock of DaemonClient.prototype.request, as the hub's other calls go. */
export function writesThroughClient(t: TestContext): void {
  t.mock.method(DaemonWriter.prototype, "request", function (this: DaemonWriter, command: Parameters<DaemonClient["request"]>[0], _slot: unknown, timeoutMs: number) {
    return DaemonClient.prototype.request.call(this as never, command, timeoutMs, { recoverable: false });
  });
}
