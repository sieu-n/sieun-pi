#!/usr/bin/env node
// Refuses a commit message whose line breaks came in as the two characters backslash and n.
// A job that builds `git commit -m "{msg}"` or `-m json.dumps(msg)` from Python gets each newline as that literal text,
// so the whole body lands in the subject. From 10-19 to 10-26, 18 of 941 commits on main had a subject like that, such as 7182031c3.
// The rule follows auto-sns-agent 052b2815ec: an escape counts only outside a code span and before a letter, digit, _, - or backslash,
// so a message that names `\n` or "kept as \n)" as text still passes. On 10-26, 27 of the 2228 messages on main had an escape it refuses, and none named \n as text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;
const ESCAPED_NEWLINE = /\\n(?=[\p{L}\p{N}_\\-])/u;
// git commit -v puts the diff below this line, and git drops everything from it on.
const SCISSORS = /^# -+ >8 -+$/m;

/** The text around the first literal backslash-n that stands for a line break outside a code span, or null. */
export function escapedNewline(message) {
  const cut = message.search(SCISSORS);
  const prose = (cut < 0 ? message : message.slice(0, cut)).replace(CODE_SPAN, " ");
  const at = prose.search(ESCAPED_NEWLINE);
  return at < 0 ? null : prose.slice(Math.max(0, at - 30), at + 30);
}

export function refusal(near) {
  return [
    `commit-msg: refused this message, because it holds a literal \\n (backslash, n) in place of a line break, near ${JSON.stringify(near)}.`,
    "Use real newlines: pass each paragraph as its own -m, or write the message to a file and pass -F <file>; from Python, quote it with shlex.quote, never json.dumps(msg), repr(msg) or -m \"{msg}\".",
    "A \\n you mean as text goes in a `code span`.",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const near = escapedNewline(readFileSync(process.argv[2], "utf8"));
    if (near !== null) {
      process.stderr.write(refusal(near));
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`escaped-newline check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
