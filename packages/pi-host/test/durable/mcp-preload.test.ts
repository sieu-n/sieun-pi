/**
 * Prime's MCP modules load with DurableRlm, before pi-host listens, so the first mcp.config after a restart does not load them on the loop. On
 * us-metal02 on 11-23 that first request held the loop 533 and 574 ms (host.log 20:00:12Z and 22:02:01Z, ~/work/pi-host-stalls/summary.md).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { DurableRlm } = await import(process.env.PI_HOST_RLM ?? "../../src/durable/rlm.ts") as typeof import("../../src/durable/rlm.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-host-mcp-preload-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("after DurableRlm.load, the mcp module's import of Prime's McpManager takes no loop turn of its own", async () => {
  const rlm = await DurableRlm.load({ agentDir: dir });
  try {
    const start = performance.now();
    await import(new URL("./core/mcp/mcp-manager.js", import.meta.resolve("prime-agent")).href);
    const ms = performance.now() - start;
    assert.ok(ms < 50, `the import took ${Math.round(ms)} ms after load`);
  } finally {
    await rlm.shutdown();
  }
});
