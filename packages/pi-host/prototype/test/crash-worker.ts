/**
 * One process of the crash test. `start` opens the session, submits the input and reports what runs, so the parent can
 * kill it at a chosen point. `inspect` reads the file without writing. `resume` reopens it, resumes and waits for the
 * same request id to settle, then reports the transcripts.
 *
 *   node --import tsx pi-host/prototype/test/crash-worker.ts <start|inspect|resume> <db file> <faux|real>
 *
 * Every line on stdout is one JSON event. Faux mode needs FAKE_POOL_DIR, the state folder of ../../pool/test/fake-pool.mjs.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationId, EntryRecord, Harness, LiveState } from "@earendil-works/pi-durable";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDurableHost } from "../src/host.ts";
import { poolProvider } from "../src/pool-provider.ts";
import { fauxRespond, INPUT, MODEL, REQUEST_ID, textOf, type EntrySummary } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
function modelsFor(mode: string, treeKey: string) {
  const models = createModels();
  if (mode === "real") {
    models.setProvider(poolProvider({ treeKey }));
    return models;
  }
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }], tokensPerSecond: 40 });
  faux.setResponses(Array.from({ length: 64 }, () => fauxRespond));
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "pi-pool", "test", "fake-pool.mjs");
  models.setProvider(poolProvider({ treeKey, bin, inner: faux.provider }));
  return models;
}

const say = (event: string, data: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ event, at: Date.now(), ...data }) + "\n");

function summarize(entry: EntryRecord): EntrySummary {
  const m = entry.model?.[0] as (Message & { stopReason?: string; toolName?: string; isError?: boolean }) | undefined;
  const summary: EntrySummary = { id: entry.id, kind: entry.kind, text: "" };
  if (!m) return summary;
  summary.role = m.role;
  if (m.role === "system") return summary;
  summary.text = textOf(m.content);
  if (m.role === "assistant") {
    summary.stopReason = (m as AssistantMessage).stopReason;
    if ((m as AssistantMessage).errorMessage) summary.error = (m as AssistantMessage).errorMessage;
    const calls = (m as AssistantMessage).content.flatMap(c => (c.type === "toolCall" ? [c.name] : []));
    if (calls.length) summary.tools = calls;
  }
  if (m.role === "toolResult") {
    summary.toolName = m.toolName;
    summary.isError = m.isError;
  }
  return summary;
}

/** Every conversation in the file, with its entries, its owner and its live state. */
async function dump(harness: Harness) {
  const conversations = await harness.commit(async tx => (await tx.scanConversations({}, 100)).items, context);
  const out: Record<string, unknown>[] = [];
  for (const record of conversations) {
    const conversation = await harness.conversation(record.id, context);
    const entries = (await conversation!.entries({ order: "ascending" }, 1000, undefined, context)).items.map(summarize);
    const watch = await conversation!.watch(context);
    const live = watch.value.docs["pi.live"] as LiveState | undefined;
    await watch.stop();
    out.push({ id: record.id, owner: record.owner ?? null, entries, live: live ? { run: Boolean(live.run), generation: live.generation ? { attempt: live.generation.attempt, retry: live.generation.retry, deferred: live.generation.deferred, partial: Boolean(live.generation.message) } : null, tools: live.tools?.length ?? 0 } : null });
  }
  return out;
}

async function main() {
  const [phase, file, mode] = process.argv.slice(2);
  if (!phase || !file || (mode !== "faux" && mode !== "real")) throw new Error("usage: crash-worker.ts <start|inspect|resume> <db file> <faux|real>");
  const started = Date.now();
  const models = modelsFor(mode, `pi-durable:${file}`);
  const { harness, root } = await openDurableHost({ file, models, model: MODEL, thinkingLevel: mode === "real" ? "high" : "off", readOnly: phase === "inspect", onReport: (error, info) => say("report", { info, error: String(error) }) }, context);
  say("opened", { ms: Date.now() - started });

  if (phase === "inspect") {
    say("dump", { conversations: await dump(harness) });
    await harness.close(context);
    return;
  }

  if (phase === "start") {
    const seen = new Set<string>();
    const once = (event: string, data: Record<string, unknown> = {}) => {
      if (seen.has(event)) return;
      seen.add(event);
      say(event, data);
    };
    const attached = new Set<ConversationId>();
    const attach = async (id: ConversationId, who: "root" | "child") => {
      attached.add(id);
      const watch = await (await harness.conversation(id, context))!.watch(context);
      watch.start(async value => {
        const live = value.docs["pi.live"] as LiveState | undefined;
        const generation = live?.generation;
        if (generation?.message && (generation.message.content as unknown[]).length > 0) once(`${who}-partial`, { conversation: id });
        if (generation?.deferred) once(`${who}-slot-wait`, { conversation: id, pollAt: generation.deferred.pollAt });
        for (const slot of live?.tools ?? []) {
          const child = (slot.details as { conversationId?: ConversationId } | undefined)?.conversationId;
          if (child !== undefined && !attached.has(child)) {
            once("child-created", { conversation: child });
            await attach(child, "child");
          }
        }
      });
    };
    await attach(root.id, "root");
    const submission = await root.submit({ type: "input", content: INPUT, requestId: REQUEST_ID }, context);
    say("submitted", { submission: submission.id });
    const settled = await submission.wait(context);
    say("settled-before-kill", { status: settled.status });
    await harness.close(context);
    return;
  }

  harness.resume();
  const submission = await root.submit({ type: "input", content: INPUT, requestId: REQUEST_ID }, context);
  const settled = await submission.wait(context);
  await harness.waitForIdle(context);
  say("settled", { submission: submission.id, status: settled.status, ms: Date.now() - started, settled });
  say("dump", { conversations: await dump(harness) });
  await harness.close(context);
}

main().then(() => process.exit(0), error => {
  say("fatal", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
