/**
 * The Chat health `unlinked_job_mentions` matcher. Owner (10-09): "씨발 무슨job인지 말해줘야될거 아니니^^" (you have to tell me which job it is).
 * A message to the owner that points at a job ("a job", "the job", "two jobs") must name it with a `job:<name>` link somewhere in it.
 */
const JOB_WORD = /(?<![\w:/.-])jobs?(?![\w:/-])/gi;
/** Text the owner does not read as prose: code spans and blocks, and markdown link targets. */
const NOT_PROSE = /```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)/g;
/** "job" as a modifier with no determiner before it ("show job reports", "job paths"): a feature, not one job. "The job reports at 10" still points. */
const MODIFIER = /^\s+(?:reports?|paths?|names?|links?|notices?)\b/i;
/** Another system's job ("a CI job", "the launchd job") or a rule for all jobs ("each job", "one goal per job"). */
const NOT_ONE_AGENT_JOB = /\b(?:CI|deploy|launchd|cron|each|every|any|per)\s+$/i;
/** A plural points at jobs only after a determiner or a count in its three words before ("my jobs", "two audit jobs"); bare "jobs" is jobs in general. */
const POINTER = /\b(?:the|my|our|their|your|its|these|those|both|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i;

function pointsAtJobs(sentence: string): boolean {
  return [...sentence.matchAll(JOB_WORD)].some(match => {
    const before = sentence.slice(0, match.index);
    const words = before.trim().split(/\s+/);
    if (NOT_ONE_AGENT_JOB.test(before)) return false;
    if (MODIFIER.test(sentence.slice(match.index + match[0].length)) && !/^(?:an?)$/i.test(words.at(-1)!) && !POINTER.test(words.at(-1)!)) return false;
    return match[0].length === 3 || POINTER.test(words.slice(-3).join(" "));
  });
}

/** The first sentence that points at a job, in a message with no `job:` link anywhere, or null. */
export function unlinkedJobSentence(text: string): string | null {
  if (/\bjob:/i.test(text)) return null;
  const sentences = text.replace(NOT_PROSE, " ").split(/(?<=[.!?])\s+|\n+/);
  return sentences.find(pointsAtJobs)?.trim() ?? null;
}
