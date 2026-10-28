#!/usr/bin/env node
/**
 * Copies Prime's harness digest code, verbatim, from the Prime source of the release the daemon runs into
 * packages/pi-host/src/durable/vendor/prime-harness.ts, which pi-host's durable threads render the `[harness-digest]` with.
 * The published prime-agent 0.9.8 package in node_modules ranks digest entries with an older scorer than the releases built from
 * Prime's load branches, so its formatter gives other bytes than a live Prime chat.
 *
 *   node scripts/vendor-prime-harness.mjs [--repo <Prime source checkout>] [--ref <git ref>] [--check]
 *
 * It also runs Prime's own refinement.ts from that commit, unchanged, on the fixture in packages/pi-host/test/fixtures/prime-harness and writes
 * its digests, fingerprints and update to expected.json there, which test/durable/prime-harness.test.ts holds pi-host's digest to.
 *
 * --repo defaults to ~/work/prime-agent-fix-p8/repo. --ref defaults to the commit whose message is `build: version <v>`, where <v> is the
 * version in the folder name of the release `~/.local/share/prime-agent/bin/prime-agent` points to. --check writes nothing and exits 1
 * when the file differs from what the ref gives, so a Prime update that changes the digest code shows up.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { tsImport } from "tsx/esm/api";

const { values } = parseArgs({ options: { repo: { type: "string" }, ref: { type: "string" }, check: { type: "boolean" } } });
const repo = resolve(values.repo ?? join(homedir(), "work/prime-agent-fix-p8/repo"));
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const out = join(root, "packages/pi-host/src/durable/vendor/prime-harness.ts");
const fixture = join(root, "packages/pi-host/test/fixtures/prime-harness");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

const release = basename(dirname(realpathSync(join(homedir(), ".local/share/prime-agent/bin/prime-agent"))));
const version = /^(.*)-linux-x64-[0-9a-f]+$/.exec(release)?.[1] ?? release;
const ref = values.ref ?? git("log", "--all", "--format=%H", "-1", "--fixed-strings", `--grep=build: version ${version}`).trim();
if (!ref) throw new Error(`no commit "build: version ${version}" in ${repo}; pass --ref`);
const sha = git("rev-parse", `${ref}^{commit}`).trim();

/** The file's top-level declarations by name, each with the comment right above it, as the source writes them. */
function declarations(path) {
  const lines = git("show", `${sha}:${path}`).split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (/^(?:export |async |function |const |let |var |interface |type |class |enum |import |\/\*\*|\/\/)/.test(line)) starts.push(index);
  });
  const chunks = starts.map((start, i) => {
    let end = (starts[i + 1] ?? lines.length) - 1;
    while (end > start && lines[end].trim() === "") end -= 1;
    return { start, end, text: lines.slice(start, end + 1).join("\n") };
  });
  const byName = new Map();
  for (const [i, chunk] of chunks.entries()) {
    const name = /^(?:export )?(?:async )?(?:function|const|let|interface|type|class) ([A-Za-z0-9_$]+)/.exec(chunk.text)?.[1];
    if (!name) continue;
    // A comment chunk that ends right above the declaration is its doc comment.
    let text = chunk.text;
    for (let j = i - 1; j >= 0 && /^(\/\*\*|\/\/)/.test(chunks[j].text) && chunks[j].end + 1 === chunks[j + 1].start; j -= 1) text = `${chunks[j].text}\n${text}`;
    byName.set(name, { start: chunk.start, text });
  }
  return { byName, blob: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

const SOURCES = {
  "packages/coding-agent/src/core/refinement/refinement.ts": [
    "HARNESS_STATE_DIR_NAME", "DEFAULT_OVERVIEW_ENTRY_LIMIT", "DEFAULT_OVERVIEW_REFINEMENT_LIMIT", "DEFAULT_OVERVIEW_CONTENT_LIMIT",
    "HARNESS_DIGEST_FINGERPRINT_VERSION", "RefinementKind", "HarnessScope", "HarnessEntry", "HarnessRefinementEvent", "HarnessState",
    "emptyHarnessState", "cloneEntry", "objectRecord", "storedHarnessPath", "normalizeHarnessScope", "getGlobalHarnessStateDir",
    "getLocalHarnessStateDir", "getHarnessStatePath", "loadHarnessState", "mergeHarnessStates", "harnessEntryMalformation",
    "harnessRefinementMalformation", "malformedRefinementEventLabel", "compactText", "HarnessQueryTerms", "CJK_TERM_RANGES",
    "CJK_TERM_PATTERN", "CJK_TERM_SPLIT", "WORD_RUN", "COMPOUND_RUN", "HARNESS_QUERY_STOPWORDS", "HARNESS_BM25_K1", "HARNESS_BM25_B",
    "DIGITS_ONLY", "isCjkSegment", "isNumberedPhrase", "stemHarnessWord", "restoreStemEnd", "isConsonant", "hasVowel", "porterMeasure",
    "endsConsonantVowelConsonant", "harnessQueryTerms", "harnessDigestQueryTerms", "SearchableField", "SearchableEntry", "searchableField",
    "searchableEntry", "countSubstring", "termCount", "TermMatch", "termMatch", "entryMatches", "corpusIdf", "scoreHarnessEntries",
    "compareHarnessEntryIdentity", "formatHarnessStateForPrompt", "harnessEntryKey", "formatHarnessEntryLine", "formatHarnessRefinementLine",
    "RENDERED_ENTRY_LINE", "REMOVED_ENTRY_LINE", "deliveredHarnessEntryLines", "changedAtOrAfter", "formatHarnessDigestDelta",
    "harnessDigestFingerprint",
  ],
  "packages/coding-agent/src/core/messages.ts": [
    "HARNESS_DIGEST_CUSTOM_TYPE", "HarnessDigestDetails", "HARNESS_DIGEST_PREFIX", "HARNESS_DIGEST_SUFFIX", "HARNESS_DIGEST_DELTA_PREFIX",
    "HARNESS_DIGEST_DELTA_SUFFIX",
  ],
};

const parts = [];
const hashes = [];
for (const [path, names] of Object.entries(SOURCES)) {
  const { byName, blob } = declarations(path);
  hashes.push(` * - ${path} (sha256 ${blob})`);
  const picked = names.map(name => {
    const found = byName.get(name);
    if (!found) throw new Error(`${path} at ${sha} has no top-level ${name}`);
    return found;
  }).sort((a, b) => a.start - b.start);
  parts.push(`// ---- ${path}\n\n${picked.map(found => found.text).join("\n\n")}`);
}

const text = `// Generated by scripts/vendor-prime-harness.mjs. Do not edit: run it again after a Prime update.
/**
 * Prime's harness digest code, copied verbatim from Prime's source at ${sha}
 * (${version}), the release the daemon ran when this file was made:
${hashes.join("\n")}
 *
 * Prime Agent is MIT licensed: Copyright (c) 2025 Mario Zechner, Copyright (c) 2026 Prime Intellect.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Prime's agent dir lookup, which the copied defaults name; pi-host always passes the dir. */
function getAgentDir(): string {
\tthrow new Error("pass the harness state dir");
}

${parts.join("\n\n")}
`;

// ---- Prime's whole refinement.ts at the commit, with stubs for the modules it imports, on the fixture.
const REFINEMENT = "packages/coding-agent/src/core/refinement/refinement.ts";
const STUBS = {
  "config.ts": "export const getAgentDir = () => { throw new Error(\"no agent dir\"); };",
  "utils/atomic-file.ts": "export const realpathIfPresentSync = (p: string) => p; export const writeFileAtomicSync = () => {};",
  "core/compaction/utils.ts": "export const serializeConversation = () => \"\";",
  "core/messages.ts": "export const convertToLlm = (m: unknown) => m;",
  "core/provider-retry.ts": "export const completeWithProviderRetry = () => { throw new Error(\"no model\"); };",
  "core/thinking-levels.ts": "export const getAuxiliaryThinkingLevel = () => undefined;",
  "core/session-manager.ts": "export {};",
  "node_modules/@earendil-works/pi-ai/package.json": JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", main: "index.js" }),
  "node_modules/@earendil-works/pi-ai/index.js": "export const completeSimple = () => { throw new Error(\"no model\"); };",
  "node_modules/@earendil-works/pi-agent-core/package.json": JSON.stringify({ name: "@earendil-works/pi-agent-core", type: "module", main: "index.js" }),
  "node_modules/@earendil-works/pi-agent-core/index.js": "export {};",
};
async function primeExpected() {
  const tmp = mkdtempSync(join(tmpdir(), "prime-harness-oracle-"));
  try {
    for (const [path, text] of Object.entries({ ...STUBS, "core/refinement/refinement.ts": git("show", `${sha}:${REFINEMENT}`) })) {
      mkdirSync(dirname(join(tmp, path)), { recursive: true });
      writeFileSync(join(tmp, path), text);
    }
    const prime = await tsImport(join(tmp, "core/refinement/refinement.ts"), import.meta.url);
    const testCase = JSON.parse(readFileSync(join(fixture, "case.json"), "utf8"));
    const merged = dir => prime.mergeHarnessStates(prime.loadHarnessState(join(dir, "global"), "global"), prime.loadHarnessState(join(dir, "local"), "local"));
    // agent-session.ts `_buildHarnessDigestQueryTerms`: the turn's input, the goal, then the last four message texts, newest first.
    const recent = testCase.recent.filter(Boolean).slice(-4).reverse();
    const queryTerms = prime.harnessDigestQueryTerms([{ text: [...testCase.input].reverse().join("\n"), weight: 4 }, { text: "", weight: 3 },
      ...recent.map((text, index) => ({ text, weight: Math.max(1, 2 - index * 0.5) }))]);
    const profiles = { prime: { includeIpythonExamples: true, includeShellExamples: false, includeRefineExamples: true }, pi: { includeIpythonExamples: false, includeShellExamples: true, includeRefineExamples: false } };
    const result = { sha, version };
    const state = merged(fixture);
    for (const [name, flags] of Object.entries(profiles)) {
      result[name] = { digest: prime.formatHarnessStateForPrompt(state, { ...flags, queryTerms }), stateFingerprint: prime.harnessDigestFingerprint(state, flags) };
    }
    const changed = merged(join(fixture, "changed"));
    const digestPrefix = /export const HARNESS_DIGEST_PREFIX = `([^`]*)`/.exec(git("show", `${sha}:packages/coding-agent/src/core/messages.ts`))[1];
    const digestSuffix = /export const HARNESS_DIGEST_SUFFIX = `([^`]*)`/.exec(git("show", `${sha}:packages/coding-agent/src/core/messages.ts`))[1];
    result.changed = {
      digest: prime.formatHarnessStateForPrompt(changed, { ...profiles.prime, queryTerms }),
      stateFingerprint: prime.harnessDigestFingerprint(changed, profiles.prime),
      delta: prime.formatHarnessDigestDelta(changed, [digestPrefix + result.prime.digest + digestSuffix], Date.parse(testCase.since)),
    };
    return `${JSON.stringify(result, null, 2)}\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const expectedPath = join(fixture, "expected.json");
const expected = await primeExpected();

if (values.check) {
  const current = readFileSync(out, "utf8");
  const currentExpected = readFileSync(expectedPath, "utf8");
  if (current !== text || currentExpected !== expected) {
    process.stderr.write(`${current !== text ? out : expectedPath} differs from ${sha} (${version}); run node scripts/vendor-prime-harness.mjs\n`);
    process.exit(1);
  }
  process.stdout.write(`${out} and ${expectedPath} match ${sha} (${version})\n`);
} else {
  writeFileSync(out, text);
  writeFileSync(expectedPath, expected);
  process.stdout.write(`wrote ${out} and ${expectedPath} from ${sha} (${version})\n`);
}
