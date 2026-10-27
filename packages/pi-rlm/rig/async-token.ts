/**
 * A rig extension that vends the Anthropic token through pi-pool's token hook asynchronously in `before_provider_headers`, the same vend
 * models.json's `!pi-pool-token` does but without Pi's execSync. It skips the pool's turn queue like that path does. Set PI_POOL_TOKEN_BIN
 * to use another hook.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const bin = process.env.PI_POOL_TOKEN_BIN ?? join(homedir(), ".config", "pi-pool", "bin", "pi-pool-token");

export default function asyncToken(pi: ExtensionAPI): void {
  pi.registerProvider("anthropic", { apiKey: "sk-ant-oat01-rig-placeholder" });
  pi.on("before_provider_headers", async (event, ctx) => {
    if (ctx.model?.provider !== "anthropic") return;
    const token = await new Promise<string>((resolve, reject) =>
      execFile(bin, ["--provider", "anthropic"], { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
    );
    event.headers.authorization = `Bearer ${token}`;
    event.headers["x-api-key"] = null;
  });
}
