/**
 * A hit's snippet and its longer text are what pi-host's `snippetOf` gives, read without the words past the snippet's end. On 11-19 the
 * 20 hits of `kimchi` on :5184 held 141,785 characters, and their snippets took 23 ms of the search's 55 to 60 ms, since each one read
 * every word of up to 12,000 characters and took the accents off each word.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { snippetOf } from "../../../../packages/pi-host/src/durable/index-db.ts";
import { fullText, matches, safeSnippet, snippet } from "../../server/search-snippet.ts";

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The snippet as it was built until 11-19: every word of the text read and folded. */
function oldMatches(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) if (terms.some(t => fold(m[0]).startsWith(t))) return true;
  return false;
}
const oldSnippet = (text: string, terms: readonly string[], size = 36): string => (oldMatches(text, terms) ? safeSnippet(snippetOf(text, terms, size)) : "");
function oldFullText(text: string, terms: readonly string[], max = 2000): string {
  let start = 0;
  if (text.length > max && terms.length) {
    const first = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "iu").exec(text);
    start = first ? Math.max(0, Math.min(first.index - 300, text.length - max)) : 0;
  }
  const slice = text.slice(start, start + max);
  return (start > 0 ? "…" : "") + safeSnippet(snippetOf(slice, terms, 1e9)) + (start + max < text.length ? "…" : "");
}

/** A seeded generator, so a failure names a text that fails again. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FILLER = ["the", "relay", "wrote", "a", "line", "of", "output", "42", "Über", "café", "cafe\u0301", "naïve", "<b>", "&", "\"key\":", "{", "}", "김치", "찌개", "x_y", "2026-11-19", "\n", "…", "🙂", "İstanbul", "ǅ"];
const HITS = ["kimchi", "Kimchi", "KIMCHIS", "kímchi", "zebra", "Zèbre", "zebras"];

function text(next: () => number, words: number, hitRate: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(next() < hitRate ? HITS[Math.floor(next() * HITS.length)]! : FILLER[Math.floor(next() * FILLER.length)]!);
  return out.join(next() < 0.1 ? "" : next() < 0.5 ? " " : ", ");
}

test("a snippet and a longer text are the ones the full read gave, for 3,000 texts with a match at any place or none", () => {
  const next = random(20261119);
  for (let round = 0; round < 3000; round++) {
    const words = Math.floor(next() ** 3 * 700);
    const body = text(next, words, [0, 0.002, 0.02, 0.3][Math.floor(next() * 4)]!);
    const terms = [["kimchi"], ["zebra"], ["kimchi", "zebr"], ["k"], ["cafe"], ["uber", "ist"], ["김"], ["42"], []][Math.floor(next() * 9)]!;
    assert.equal(matches(body, terms), oldMatches(body, terms), JSON.stringify({ body, terms }));
    for (const size of [36, 24, 1, 3]) assert.equal(snippet(body, terms, size), oldSnippet(body, terms, size), JSON.stringify({ body, terms, size }));
    for (const max of [2000, 120]) assert.equal(fullText(body, terms, max), oldFullText(body, terms, max), JSON.stringify({ body, terms, max }));
  }
});

test("a snippet of a long text with an early match reads no more than its own words", () => {
  // A 12,000-character text is the longest one a hit's snippet is cut from (search-snippet.ts `around`), with its match 2,000 characters in.
  const before = "ünïcode word and a plain one, ".repeat(67);
  const long = `${before}the kimchi line ${"then más words follow it. ".repeat(400)}`.slice(0, 12_000);
  const terms = ["kimchi"];
  assert.equal(snippet(long, terms), oldSnippet(long, terms));
  const time = (run: () => void): number => {
    const times: number[] = [];
    for (let round = 0; round < 15; round++) {
      const started = performance.now();
      for (let i = 0; i < 20; i++) run();
      times.push(performance.now() - started);
    }
    return times.sort((a, b) => a - b)[7]!;
  };
  const now = time(() => snippet(long, terms));
  const was = time(() => oldSnippet(long, terms));
  // The match sits a sixth of the way in and the read ends after it: us-metal02 measured 9.9, 10.8 and 11.7 times on 11-19, and the limit is half of that.
  assert.ok(was / now > 5, `20 snippets took ${now.toFixed(2)} ms against ${was.toFixed(2)} ms for the full read, ${(was / now).toFixed(1)} times`);
});
