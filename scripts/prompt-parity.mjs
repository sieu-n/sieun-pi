#!/usr/bin/env node
/**
 * Dumps a Prime chat's prompt and a pi thread's prompt side by side and compares them part by part. Read-only: it reads Prime's
 * captured request, the session file, the agent dir and the pi thread's SQLite file, and writes only under --out.
 *
 *   node scripts/prompt-parity.mjs --out /tmp/parity [--agent-dir ~/.prime/agent] [--session <prime chat session id>] [--thread <pi thread id>] [--tools prime|pi]
 *
 * Prime side: the exact request a Prime browser chat last sent, which the legacy chat's user-history extension writes on every request
 * (`<agent dir>/browser-chat/prompts/<session>.json`, legacy/prime/user-history/src/prompt-capture.ts). Default: the newest capture of a
 * chat root listed in `browser-chat/chats.json`.
 * pi side: what pi-host's prompt builder (packages/pi-host/src/durable/prime-prompt.ts) renders for the same cwd, session file and brief,
 * and what the pi thread's file holds today (the replayed `pi.system` entries of its root conversation).
 *
 * Harness digest: Prime's newest digest message in the chat's session file against what pi-host's delivery code (prime-harness.ts) sends for
 * the same global and local entries and the same messages, the way an imported thread holds them. It compares only when the stores still have
 * the fingerprint that message recorded, since they change all day; the capture's own digest is from an older state.
 *
 * Tools: each tool of the capture against the definition a pi thread offers, as pi-ai's Anthropic provider sends it (name, description,
 * `input_schema` {type, properties, required}); the chat tools come from Prime's own chat extension as pi-host loads it (prime-chat.ts),
 * and ipython from pi-rlm's extension as rlm.ts loads it.
 *
 * Writes prime/*.txt, builder/*.txt, pi-live/*.txt, pi-tools.json, summary.json and summary.md under --out.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { register } from "tsx/esm/api";

register();
const { values } = parseArgs({ options: { out: { type: "string" }, "agent-dir": { type: "string" }, session: { type: "string" }, thread: { type: "string" }, tools: { type: "string" } } });
if (!values.out) {
  process.stderr.write("usage: prompt-parity.mjs --out <dir> [--agent-dir <dir>] [--session <id>] [--thread <id>] [--tools prime|pi]\n");
  process.exit(2);
}
const out = resolve(values.out);
const agentDir = resolve(values["agent-dir"] ?? join(homedir(), ".prime/agent"));
const tools = values.tools === "pi" ? "pi" : "prime";
const builder = await import("../packages/pi-host/src/durable/prime-prompt.ts");
const { CHAT_BRIEF } = await import("../legacy/prime/user-history/src/chat-brief.ts");

const write = (path, text) => {
  mkdirSync(join(out, path, ".."), { recursive: true });
  writeFileSync(join(out, path), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
};
const bytes = text => Buffer.byteLength(text ?? "", "utf8");
const textOf = content => (typeof content === "string" ? content
  : (content ?? []).flatMap(block => (["text", "input_text", "output_text"].includes(block.type) ? [block.text] : [])).join("\n"));

// ---- Prime: the captured request of a chat root.
const prompts = join(agentDir, "browser-chat", "prompts");
const chats = new Set(JSON.parse(readFileSync(join(agentDir, "browser-chat", "chats.json"), "utf8")).ids ?? []);
const session = values.session ?? readdirSync(prompts).filter(name => name.endsWith(".json") && chats.has(name.slice(0, -5)))
  .map(name => ({ name, at: statSync(join(prompts, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0]?.name.slice(0, -5);
if (!session) throw new Error(`no chat capture under ${prompts}`);
const capture = JSON.parse(readFileSync(join(prompts, `${session}.json`), "utf8"));
const payload = capture.payload;
// Anthropic: the identity block and the prompt; OpenAI Responses: `instructions` and `input`.
const [identity, system] = Array.isArray(payload.system) ? payload.system.map(block => block.text) : ["", payload.instructions ?? ""];
const messages = (payload.messages ?? payload.input ?? []).map(message => textOf(message.content));
const primeRules = messages.find(text => text.startsWith("Project rules from ")) ?? null;
// A compacted chat's first message carries its digest snapshot before the summary, so the digest is the text up to its closing tag.
const primeHarness = messages.find(text => text.startsWith("[harness-digest]\n"))?.replace(/(<\/harness_state>)[\s\S]*$/, "$1") ?? null;
const primeUpdates = messages.filter(text => text.startsWith("[harness-digest update]\n"));
const primeCorrections = messages.findLast(text => text.startsWith("[corrections] ")) ?? null;
write("prime/identity.txt", identity);
write("prime/system.txt", system);
write("prime/tools.json", payload.tools);
if (primeRules) write("prime/rules.txt", primeRules);
if (primeHarness) write("prime/harness.txt", primeHarness);
if (primeUpdates.length) write("prime/harness-updates.txt", primeUpdates.join("\n\n"));
if (primeCorrections) write("prime/corrections.txt", primeCorrections);

// The brief the chat pinned since its last compaction (chat-brief.ts pinnedBrief): Prime keeps that one in its prompt.
let brief = CHAT_BRIEF;
let pinned = "current CHAT_BRIEF (no pin found)";
if (capture.sessionFile && existsSync(capture.sessionFile)) {
  const branch = readFileSync(capture.sessionFile, "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const compact = branch.findLastIndex(entry => entry.type === "compaction");
  const pin = branch.slice(compact + 1).findLast(entry => entry.type === "custom" && entry.customType === "chat_brief");
  if (Array.isArray(pin?.data?.lines)) {
    brief = pin.data.lines;
    pinned = brief.join("\n") === CHAT_BRIEF.join("\n") ? "pinned brief, equal to the current CHAT_BRIEF" : "pinned brief, older than the current CHAT_BRIEF";
  }
}

// ---- The builder, for the same inputs.
const cwd = /^Working directory: (.*)$/m.exec(system)?.[1] ?? homedir();
// The Prime release whose bundled skills the capture lists: a running Prime session keeps the release it started on, while the builder
// takes the one installed now (bundledSkillsDir()). The comparison uses the capture's when it is still on disk, and the summary names both.
const installedBundled = builder.bundledSkillsDir();
const captureBundled = /<location>(\/[^<]*\/releases\/[^/<]+\/skills)\//.exec(system)?.[1];
const bundledSkillsDir = captureBundled && existsSync(captureBundled) ? captureBundled : installedBundled;
const harnessDir = capture.sessionFile ? (await import("../packages/pi-host/src/durable/prime-harness.ts")).threadHarnessDir(capture.sessionFile, session) : undefined;
const input = { agentDir, cwd, messagesPath: capture.sessionFile ?? undefined, depth: 0, tools, brief, bundledSkillsDir, ...(harnessDir ? { harnessDir } : {}) };
const parts = await builder.primePromptParts(input);
const primeJoined = parts.filter(part => builder.PRIME_SECTIONS.includes(part.key)).map(part => part.text).join("\n\n");
for (const part of parts) write(`builder/${part.key}.txt`, part.text);
write("builder/system.txt", parts.map(part => part.text).join("\n\n"));

const firstDiff = (a, b) => {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return at === a.length && a.length === b.length ? null : { at, prime: b.slice(Math.max(0, at - 80), at + 160), pi: a.slice(Math.max(0, at - 80), at + 160) };
};

// ---- The pi thread as its file holds it today.
const durable = join(agentDir, "pi-host", "durable");
let live = null;
const threadsDir = join(durable, "threads");
const thread = values.thread ?? (existsSync(threadsDir) ? readdirSync(threadsDir).filter(name => name.endsWith(".sqlite"))
  .map(name => ({ name, at: Math.max(...[name, `${name}-wal`].map(file => statSync(join(threadsDir, file), { throwIfNoEntry: false })?.mtimeMs ?? 0)) }))
  .sort((a, b) => b.at - a.at)[0]?.name.slice(0, -".sqlite".length) : undefined);
if (thread) {
  const db = new DatabaseSync(`file:${join(threadsDir, `${thread}.sqlite`)}?mode=ro`, { readOnly: true });
  const sections = new Map();
  const tools = new Map();
  for (const row of db.prepare("select record from entries where conversation_id = 1 order by id").all()) {
    const record = JSON.parse(row.record);
    if (record.kind !== "pi.system") continue;
    for (const message of record.model ?? []) {
      for (const [key, value] of Object.entries(message.sections ?? {})) value === null ? sections.delete(key) : sections.set(key, value);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    }
  }
  db.close();
  live = { thread, sections: [...sections].map(([key, text]) => ({ key, bytes: bytes(text) })), tools: [...tools.keys()] };
  write("pi-live/system.txt", [...sections.values()].join("\n\n"));
  write("pi-live/tools.json", [...tools.values()]);
}

// ---- Harness digest: Prime's newest digest message against pi-host's delivery for the same entries and messages.
const harnessCode = await import("../packages/pi-host/src/durable/prime-harness.ts");
const harnessVendor = await import("../packages/pi-host/src/durable/vendor/prime-harness.ts");
function harnessCheck() {
  if (!capture.sessionFile || !existsSync(capture.sessionFile)) return null;
  const rows = readFileSync(capture.sessionFile, "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const at = rows.findLastIndex(row => row.type === "custom_message" && row.customType === "harness_digest");
  if (at < 0) return null;
  const latest = rows[at];
  // Prime's context at that turn: the newest compaction, the entries it kept, and the entries after it.
  const compaction = rows.slice(0, at).findLastIndex(row => row.type === "compaction");
  let context = rows.slice(0, at);
  if (compaction >= 0) {
    const kept = rows.findIndex(row => row.id === rows[compaction].firstKeptEntryId);
    context = [rows[compaction], ...rows.slice(kept >= 0 && kept < compaction ? kept : compaction + 1, compaction), ...rows.slice(compaction + 1, at)];
  }
  // Each Prime message as the durable entry an imported thread holds (import.ts): a custom message is a `prime.custom` user message.
  const asEntry = row => row.type === "message" ? { kind: row.message.role === "assistant" ? "pi.assistant" : row.message.role === "user" ? "pi.user" : "pi.tool-result", message: row.message }
    : row.type === "custom_message" ? { kind: "prime.custom", message: { role: "user", content: row.content }, customType: row.customType }
      : row.type === "compaction" ? { kind: "pi.compaction", message: { role: "user", content: String(row.summary ?? "") } } : null;
  const entries = context.map(asEntry).filter(entry => entry && entry.customType !== "harness_digest");
  const view = { head: undefined, entries: entries.map((entry, id) => ({ id: id + 1, kind: entry.kind })), contributions: entries.map(entry => [entry.message]), messages: [] };
  // The turn's input: the messages written right after the digest, which rides the turn's delivery records. A digest Prime appends at a
  // cold boundary (a resume, a settle) has other entries after it and no input.
  const input = [];
  for (const row of rows.slice(at + 1)) {
    const entry = asEntry(row);
    if (!entry || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") break;
    input.push(harnessCode.queryText({ kind: entry.kind }, entry.message));
  }
  const delivered = [
    ...(compaction >= 0 && rows[compaction].harnessDigest !== undefined ? [{ at: Date.parse(rows[compaction].timestamp), text: rows[compaction].harnessDigest, digest: rows[compaction].harnessDigest, stateFingerprint: rows[compaction].harnessStateFingerprint }] : []),
    // Prime's rebuilt context keeps no digest message from before its compaction (session-manager.ts), only the snapshot.
    ...rows.slice(compaction + 1, at).filter(row => row.type === "custom_message" && row.customType === "harness_digest")
      .map(row => ({ at: Date.parse(row.timestamp), text: typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join("\n"), digest: row.details?.digest, stateFingerprint: row.details?.stateFingerprint })),
  ].sort((a, b) => a.at - b.at);
  const local = harnessCode.threadHarnessDir(capture.sessionFile, session);
  const state = harnessCode.mergedHarnessState(agentDir, local);
  const flags = harnessCode.digestFlags(builder.TOOLS[tools].root, skillsLoaded);
  const fingerprint = harnessVendor.harnessDigestFingerprint(state, flags);
  const content = typeof latest.content === "string" ? latest.content : latest.content.map(part => part.text ?? "").join("\n");
  const base = { at: latest.timestamp, local, localEntries: Object.values(harnessVendor.loadHarnessState(local, "local").entries).reduce((n, kind) => n + Object.keys(kind).length, 0),
    primeDigestBytes: bytes(latest.details.digest), primeMessageBytes: bytes(content), stacked: Boolean(latest.details.stacked) };
  if (fingerprint !== latest.details.stateFingerprint) return { ...base, sameEntries: false };
  const recent = harnessCode.contextTexts(view);
  const full = harnessCode.nextDelivery({ state, flags, input, recent, delivered: [], after: 0, now: 0 });
  // The message itself: the full digest, or the update against the digests the context held before it.
  const before = delivered.filter(d => d.at < Date.parse(latest.timestamp));
  const sent = latest.details.stacked ? harnessCode.nextDelivery({ state, flags, input, recent, delivered: before, after: 0, now: 0 }) : full;
  const piMessage = sent?.text ?? "";
  write("harness/prime-message.txt", content);
  write("harness/pi-message.txt", piMessage);
  write("harness/prime-digest.txt", latest.details.digest);
  write("harness/pi-digest.txt", full.digest);
  return { ...base, sameEntries: true, piDigestBytes: bytes(full.digest), digestIdentical: full.digest === latest.details.digest, piMessageBytes: bytes(piMessage), messageIdentical: piMessage === content };
}
const skillsLoaded = (await builder.primeResources(agentDir, cwd, bundledSkillsDir)).skills;
const harness = harnessCheck();
if (harness) write("harness.json", harness);

// ---- Tools: what a pi thread offers, from the same code pi-host runs (prime-chat.ts loads the user-history extension as a chat).
const chatModule = await import("../packages/pi-host/src/durable/prime-chat.ts");
const chat = await chatModule.loadPrimeChat({ agentDir, dataDir: join(agentDir, "browser-chat") });
const wire = tool => ({ name: tool.name, description: tool.description,
  input_schema: { type: "object", properties: tool.parameters?.properties ?? {}, required: tool.parameters?.required ?? [] } });
// Prime's ipython as pi-host's durable threads offer it: pi-rlm's own registration, loaded through the same adapter (rlm.ts).
const ipython = await (await import("../packages/pi-host/src/durable/rlm.ts")).loadIpythonTool();
const piTools = new Map([ipython, ...chat.tools].map(tool => [tool.name, wire(tool)]));
write("pi-tools.json", [...piTools.values()]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toolRows = payload.tools.map(tool => {
  const pi = piTools.get(tool.name);
  if (!pi) return { name: tool.name, parity: "missing in pi", primeBytes: bytes(tool.description) };
  const primeWire = { name: tool.name, description: tool.description, input_schema: { type: "object", properties: tool.input_schema?.properties ?? {}, required: tool.input_schema?.required ?? [] } };
  const parity = sameJson(pi, primeWire) ? "identical" : sameJson(pi.description, primeWire.description) ? "different schema" : "different description";
  return { name: tool.name, parity, primeBytes: bytes(tool.description), piBytes: bytes(pi.description) };
});
for (const name of piTools.keys()) if (!payload.tools.some(tool => tool.name === name)) toolRows.push({ name, parity: "pi only (not in this capture)", piBytes: bytes(piTools.get(name).description) });

// ---- Compare.
const lineDiff = (pi, prime) => {
  if (pi === prime || prime === null || prime === undefined) return null;
  const a = new Set(pi.split("\n"));
  const b = new Set(prime.split("\n"));
  return { onlyPi: [...a].filter(line => !b.has(line)).length, onlyPrime: [...b].filter(line => !a.has(line)).length, shared: [...a].filter(line => b.has(line)).length };
};
const rows = parts.map(part => {
  const prime = builder.PRIME_SECTIONS.includes(part.key) ? system : { rules: primeRules, harness: primeHarness, corrections: primeCorrections }[part.key];
  const where = builder.PRIME_SECTIONS.includes(part.key) ? "system prompt" : "message";
  const same = part.key === "harness" && harness?.sameEntries ? (harness.digestIdentical && harness.messageIdentical ? "identical for the same entries (newest digest message)" : "different for the same entries")
    : part.key === "harness" && harness ? "stores changed since the newest digest message"
    : prime === null || prime === undefined ? "absent in capture" : builder.PRIME_SECTIONS.includes(part.key) ? (prime.includes(part.text) ? "identical" : "different")
    : prime === part.text ? "identical" : "different";
  const liveBytes = live?.sections.find(section => section.key === part.key)?.bytes ?? 0;
  const lines = where === "message" ? lineDiff(part.text, prime) : null;
  return { key: part.key, source: part.source, primeAt: where, builderBytes: bytes(part.text), primeBytes: where === "system prompt" ? null : bytes(prime), parity: same, lines, liveBytes };
});
const summary = {
  capturedAt: capture.capturedAt, session, sessionFile: capture.sessionFile, cwd, brief: pinned, tools, bundledSkillsDir, installedBundled,
  primeSystemBytes: bytes(system), builderPrimeBytes: bytes(primeJoined), systemIdentical: primeJoined === system, systemDiff: firstDiff(primeJoined, system),
  identity: identity, primeTools: payload.tools.map(tool => tool.name), live, rows, toolRows, harness, primeUpdates: primeUpdates.map(bytes),
};
write("summary.json", summary);
const md = [
  `# Prompt parity, ${new Date().toISOString()}`,
  "",
  `Prime chat ${session}, captured ${capture.capturedAt}, cwd ${cwd}, ${pinned}. Builder tools profile: ${tools}.`,
  "",
  `Bundled skills compared from ${bundledSkillsDir}${bundledSkillsDir === installedBundled ? " (the installed release)" : `; the installed release is ${installedBundled}, which a pi thread lists`}.`,
  "",
  `Prime system block: ${summary.primeSystemBytes} bytes. Builder's Prime sections joined: ${summary.builderPrimeBytes} bytes. Identical: ${summary.systemIdentical ? "yes" : "no"}.`,
  ...(summary.systemDiff ? ["", "First difference:", "", "```", `prime: ${JSON.stringify(summary.systemDiff.prime)}`, `pi:    ${JSON.stringify(summary.systemDiff.pi)}`, "```"] : []),
  "",
  "| Section | Builder bytes | In Prime as | Parity with the capture | Live pi thread bytes |",
  "|---|---|---|---|---|",
  ...rows.map(row => `| ${row.key} | ${row.builderBytes} | ${row.primeAt}${row.primeBytes === null ? "" : `, ${row.primeBytes} bytes`} | ${row.parity}` +
    `${row.lines ? ` (${row.lines.shared} lines shared, ${row.lines.onlyPrime} only in Prime, ${row.lines.onlyPi} only in pi)` : ""} | ${row.liveBytes} |`),
  "",
  ...(harness ? [harness.sameEntries
    ? `Harness: Prime's newest digest message (${harness.at}, ${harness.stacked ? "an update" : "a full digest"}, ${harness.primeMessageBytes} bytes; full digest ${harness.primeDigestBytes} bytes; ${harness.localEntries} local entries) against pi-host's delivery for the same entries and messages: digest ${harness.digestIdentical ? "identical" : "different"} (${harness.piDigestBytes} bytes), message ${harness.messageIdentical ? "identical" : "different"} (${harness.piMessageBytes} bytes). The capture holds ${primeUpdates.length} update messages.`
    : `Harness: the stores changed after Prime's newest digest message (${harness.at}), so its bytes cannot be compared; run again.`, ""] : []),
  "| Tool | Parity with the capture | Prime description bytes | pi description bytes |",
  "|---|---|---|---|",
  ...toolRows.map(row => `| ${row.name} | ${row.parity} | ${row.primeBytes ?? ""} | ${row.piBytes ?? ""} |`),
  "",
  `Prime tools: ${summary.primeTools.join(", ")}.`,
  live ? `pi thread ${live.thread} tools: ${live.tools.join(", ")}; its sections today: ${live.sections.map(section => `${section.key} (${section.bytes} bytes)`).join(", ")}.` : "No pi thread found.",
  "",
].join("\n");
write("summary.md", md);
process.stdout.write(md);
