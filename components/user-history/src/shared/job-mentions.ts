/**
 * The `unlinked_job_mentions` matcher: Chat health counts with it, and tell_owner refuses with `jobLinkFinding`. Owner (10-09): "씨발 무슨job인지
 * 말해줘야될거 아니니^^" (you have to tell me which job it is). A message to the owner that points at a job ("a job", "the job", "two jobs")
 * must name it with a `job:<name>` link somewhere in it.
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

/** Text a job name is never linked inside: markdown links and images, code spans and blocks, bare URLs. */
const PROTECTED = /!?\[[^\]]*\]\([^)]*\)|```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with the first plain mention of each job name made a `[name](job:<name>)` link. Only names of two or more words are linked: a
 * one-word name ("census") reads as an ordinary word. Text inside links, code and URLs stays as it is.
 */
export function linkJobNames(text: string, jobs: readonly string[]): string {
  let linked = text;
  for (const job of [...new Set(jobs)].filter(name => name.trim().split(/\s+/).length > 1).sort((a, b) => b.length - a.length)) {
    const taken = [...linked.matchAll(PROTECTED)].map(match => [match.index!, match.index! + match[0].length] as const);
    const name = new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(job.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_-])`, "giu");
    const mention = [...linked.matchAll(name)].find(match => !taken.some(([start, end]) => match.index! >= start && match.index! < end));
    if (mention) linked = `${linked.slice(0, mention.index)}[${mention[0]}](job:${job.trim()})${linked.slice(mention.index! + mention[0].length)}`;
  }
  return linked;
}

/**
 * The reply-lint style line for a message to the owner that points at a job with no `job:` link (owner 10-09, c12), or null. When linking the
 * chat's job names (`jobs`) fixes it, the line carries the fixed text to send; otherwise it lists the job names to link.
 */
export function jobLinkFinding(text: string, jobs: readonly string[]): string | null {
  const sentence = unlinkedJobSentence(text);
  if (!sentence) return null;
  const linked = linkJobNames(text, jobs);
  if (linked !== text && !unlinkedJobSentence(linked)) return `- "${sentence}" names a job with no link: send this text, with the job linked:\n${linked}`;
  const names = jobs.length ? ` One of yours: ${jobs.map(name => `[${name}](job:${name})`).join(", ")}.` : "";
  return `- "${sentence}" points at a job with no link: name each job you mean as [name](job:name).${names} ` +
    "A CI, cron or other chat's job is not yours: call it a run or a check instead.";
}
