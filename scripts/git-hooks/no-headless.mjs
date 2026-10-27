#!/usr/bin/env node
// Owner c177, 10-27: "can you remove Headless browser???? NEVER put it back in. we'll always use Aside only."
// Refuses a commit that adds a headless browser launch to a harness path: a skill, a component, a script, config or deploy.
// Test code (test/, tests/, fixtures/) is left out, because a product's own test client may run its browser as it likes (c163).
// components/user-history/test/no-headless-browser.test.ts runs the same scan over the whole tree.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOTS = /^(skills|components|scripts|config|deploy)\//;
const SKIP = /(^|\/)(node_modules|test|tests|fixtures|__pycache__)\/|^scripts\/git-hooks\/no-headless\.mjs$/;
const CODE = /\.(ts|mts|cts|mjs|cjs|js|py|sh)$/;
const PROSE = /\.md$/;
const LAUNCH = /\b(?:chromium|firefox|webkit|puppeteer)\s*\.\s*(?:launch|launchPersistentContext)\s*\(/g;
const HEADFUL = /\bheadless["']?\s*[:=]\s*(?:false|False)\b/;
const CODE_RULES = [
  [/["'`]--headless(?:=|["'`\s])/, "a --headless flag"],
  [/\bheadless["']?\s*[:=]\s*(?!false\b|False\b)[\w!"'(]/, "a headless option that is not false"],
  [/\bplaywright\s+(?:screenshot|pdf)\b/, "the playwright screenshot CLI, which runs headless"],
];
const PROSE_RULES = [
  [/(?:^|\s|`)--headless\b/, "a --headless flag"],
  [/\bheadless["']?\s*[:=]\s*(?:true|True)\b/, "a headless option set to true"],
  [/\bplaywright\s+(?:screenshot|pdf)\b/, "the playwright screenshot CLI, which runs headless"],
];

/** Whether `path` is harness code or skill prose this guard reads. */
export const inScope = path => ROOTS.test(path) && !SKIP.test(path) && (CODE.test(path) || PROSE.test(path) && /^(skills|config)\//.test(path));

/** Each line of `text` that launches or tells an agent to launch a headless browser, as "path:line: what". */
export function headlessLaunches(path, text) {
  if (!inScope(path)) return [];
  const found = [];
  const lines = text.split("\n");
  const rules = CODE.test(path) ? CODE_RULES : PROSE_RULES;
  lines.forEach((line, index) => {
    for (const [rule, what] of rules) if (rule.test(line)) found.push(`${path}:${index + 1}: ${what}`);
  });
  if (CODE.test(path)) {
    for (const match of text.matchAll(LAUNCH)) {
      if (HEADFUL.test(text.slice(match.index, match.index + 400))) continue;
      found.push(`${path}:${text.slice(0, match.index).split("\n").length}: a browser launch without headless false, which Playwright and Puppeteer run headless`);
    }
  }
  return found;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staged = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).split("\0").filter(inScope);
  const found = staged.flatMap(path => headlessLaunches(path, git(["show", `:${path}`])));
  if (found.length) {
    process.stderr.write(`no-headless: agents browse only through Aside (owner c177), so this commit cannot add a headless browser:\n${found.map(line => `  ${line}`).join("\n")}\n`);
    process.exit(1);
  }
}
