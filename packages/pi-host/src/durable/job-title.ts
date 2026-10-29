/**
 * A job's short title for the thread tree and the chat's lists: the name it was spawned with, or, for a child whose spawner gave none (the
 * `subagent` tool before it took `name`), the gist of its task. A brief's first line ("Owner's words (verbatim):", "You are subagent A on
 * ...") never names a job.
 */

const MAX = 60;
const TASK_HEADER = /^\[task from parent\]$/i;
const OWNER_WORDS = /^(#+\s*)?(the\s+)?owner'?s words\b/i;
const LABEL = /\b(?:your job|goal|task|the problem|my read)\s*:\s*/i;

/** The name the `subagent` tool gave a child before it took `name`: the task's first line, cut at 80 characters. */
export const firstLineName = (task: string): string => task.split("\n")[0]!.trim().slice(0, 80);

/** The task's gist in at most 60 characters, cut at a word: the text after a "Your job:" or "Goal:" label, or else its first sentence. */
export function jobTitle(task: string): string {
  const paragraphs = task.split(/\n\s*\n/).map(p => p.trim()).filter(p => p && !TASK_HEADER.test(p) && !OWNER_WORDS.test(p) && !/^#+\s/.test(p));
  let text = (paragraphs[0] ?? "").split("\n")[0]!.replace(/^\[task from parent\]\s*/i, "");
  const label = LABEL.exec(text);
  if (label) text = text.slice(label.index + label[0].length);
  text = text.replace(/\s*\([^)]*\)/g, "").replace(/[`*]/g, "");
  text = (/^(.+?)[.!?](\s|$)/.exec(text)?.[1] ?? text).trim();
  if (text.length > MAX) text = text.slice(0, MAX + 1).replace(/\s+\S*$/, "");
  text = text.replace(/(\s+(a|an|the|as|of|to|for|and|or|with|by|from|like|very|in|on|at))+$/i, "").replace(/[\s,;:.-]+$/, "");
  return text;
}

/** The title a child shows: its spawn name, or the task's gist when the name is only the task's first line or empty. */
export function childTitle(name: string, task: string): string {
  if (name.trim() && name !== firstLineName(task)) return name;
  return jobTitle(task) || name || "job";
}
