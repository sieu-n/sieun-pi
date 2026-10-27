/**
 * Open question 2, settled on upstream Pi 1.4.0 with the real anthropic-messages provider against a local server.
 *   hold   HOLD_MS=600000 node --import tsx pi-pool/check/q2-probe.ts hold
 *   abort  ABORT_MS=5000 node --import tsx pi-pool/check/q2-probe.ts abort
 *   swap   node --import tsx pi-pool/check/q2-probe.ts swap
 * Prints one JSON line per step and a last JSON line with the verdict.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fakeAnthropic, openAnthropic, rateLimited } from "./rig.ts";

const mode = process.argv[2] ?? "hold";
const holdMs = Number(process.env.HOLD_MS ?? 3000);
const abortMs = Number(process.env.ABORT_MS ?? 2000);
const root = process.env.PROBE_ROOT ?? mkdtempSync(join(tmpdir(), "q2-"));
const t0 = Date.now();
const log = (step: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: Date.now() - t0, step, ...extra }));

let account = "tokA";
let hookEnds = 0;
const hold: ExtensionFactory = pi => {
  pi.on("before_provider_headers", async (event, ctx) => {
    const signal = ctx.signal;
    log("hook_start", { account, signalPresent: signal !== undefined });
    if (mode !== "swap") {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, holdMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); log("hook_saw_abort"); resolve(); }, { once: true });
      });
    }
    event.headers.authorization = `Bearer sk-ant-oat01-${account}`;
    hookEnds++;
    log("hook_end", { account });
  });
  pi.on("message_end", async event => {
    const m = event.message;
    if (m.role !== "assistant") return undefined;
    log("message_end", { stopReason: m.stopReason, errorMessage: m.errorMessage?.slice(0, 160) });
    if (m.stopReason === "error" && /429/.test(m.errorMessage ?? "")) {
      account = "tokB";
      return { message: { ...m, errorMessage: "429 rate limit: pi-pool moved this session to tokB; the retry uses it." } };
    }
    return undefined;
  });
};

const server = await fakeAnthropic(mode === "swap" ? [rateLimited(3600), { status: 200, text: "hello from B" }] : [{ status: 200, text: "held reply" }]);
const rt = await openAnthropic(root, server.url, [hold]);
rt.session.subscribe(e => { if (e.type === "auto_retry_start" || e.type === "auto_retry_end") log(e.type, { attempt: (e as { attempt?: number }).attempt }); });
const prompt = rt.session.prompt("hi");
if (mode === "abort") setTimeout(() => { log("abort_called"); void rt.session.abort(); }, abortMs);
await prompt.catch(e => log("prompt_threw", { error: String(e) }));
await new Promise(r => setTimeout(r, 1000));
const last = rt.session.messages.filter(m => m.role === "assistant").at(-1) as { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
const verdict = {
  mode, holdMs, abortMs, elapsedMs: Date.now() - t0, hookEnds,
  requests: server.seen.map(s => ({ at: s.at - t0, status: s.status, authorization: s.authorization?.replace(/oat01-.*/, "oat01-<" + s.authorization.split("oat01-")[1] + ">"), beta: s.beta })),
  lastStopReason: last?.stopReason, lastError: last?.errorMessage, lastText: rt.session.getLastAssistantText(),
};
log("verdict", verdict);
await rt.dispose();
await server.close();
process.exit(0);
