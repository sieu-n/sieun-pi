/**
 * The `unlinked_job_mentions` matcher: Chat health counts with it, and tell_owner refuses with `jobLinkFinding`. Owner (10-09): "씨발 무슨job인지
 * 말해줘야될거 아니니^^" (you have to tell me which job it is). A message to the owner that points at a job ("a job", "the job", "two jobs")
 * must name it with a `job:<name>` link somewhere in it.
 */
const JOB_WORD = /(?<![\w:/.-])jobs?(?![\w:/-])/gi;
/** Text the owner does not read as prose: code spans and blocks, and markdown link targets. */
const NOT_PROSE = /```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)/g;
/** "job" as a modifier with no determiner before it ("show job reports", "job paths"): a feature, not one job. "The job reports at 10" still points. */
const MODIFIER = /^\s+(?:reports?|paths?|names?|links?|notices?|briefs?|rules?|limits?|timeouts?)\b/i;
/**
 * Another system's job ("a CI job", "the launchd job", "the land gate's test job", "heavy jobs" on the CI runners) or a rule for all jobs
 * ("each job", "one goal per job", "in the last hour no job waited over 8 minutes").
 */
const NOT_ONE_AGENT_JOB = /\b(?:CI|deploy|launchd|cron|test|heavy|light|each|every|any|per|no)\s+$/i;
/** A CI or gate run named before the job word: its jobs are that run's ("Its gate run was green on all 8 jobs", ops guy 10-12). */
const RUN_SENTENCE = /\b(?:CI|gate|test|workflow)(?:'s)?\s+runs?\b/i;
/** A share of jobs is a rate, not a pointer ("98% of jobs ok", "66% of new-profile jobs finish", crawler VP 10-12). */
const SHARE = /\d+(?:\.\d+)?\s*%\s+of\s+(?:the\s+)?(?:[\p{L}-]+\s+)?$/iu;
/** A tally of a run's jobs ("Land 33 is 7 of 10 jobs green", VP of CI 10-12). */
const TALLY = /\b\d+\s+of\s+(?:the\s+|its\s+|all\s+)?\d+\s+$/i;
/** A rate of jobs ("the two heavy runners finish about one job every 7 minutes each", VP of CI 10-13). */
const RATE = /^\s+(?:every|per|an?|each)\s+(?:\d+\s+)?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i;
/** A plural points at jobs only after a determiner or a count in its three words before ("my jobs", "two audit jobs"); bare "jobs" is jobs in general. */
const POINTER = /\b(?:the|my|our|their|your|its|these|those|both|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i;
const DETERMINER = /^(?:an?|the|my|our|their|your|its|his|her|this|that|these|those|both|two|three|four|five|six|seven|eight|nine|ten|\d+)$/i;
/** A unit word: the count before it counts that unit ("every 15 minutes while jobs stay clean"), not the jobs. */
const UNIT = /^(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|ms|s|h|m|KB|MB|GB|TB|%)$/i;
const AND_OR = /^(?:and|or)$/i;

function pointsAtJobs(sentence: string): boolean {
  return [...sentence.matchAll(JOB_WORD)].some(match => {
    const before = sentence.slice(0, match.index);
    const after = sentence.slice(match.index + match[0].length);
    const words = before.trim().split(/\s+/);
    if (NOT_ONE_AGENT_JOB.test(before) || SHARE.test(before) || TALLY.test(before) || RUN_SENTENCE.test(before) || RATE.test(after)) return false;
    if (MODIFIER.test(after) && !/^(?:an?)$/i.test(words.at(-1)!) && !POINTER.test(words.at(-1)!)) return false;
    // A noun list names jobs in general: "chats and jobs", "chat and job briefs", "Board, job and git rules", "a bad package or broken job".
    const clause = before.split(/[,:;()]/).at(-1)!.trim().split(/\s+/).filter(Boolean);
    const last = clause.at(-1) ?? "", previous = clause.at(-2) ?? "";
    if (AND_OR.test(last) || (AND_OR.test(previous) && !DETERMINER.test(last)) || (/^\s+(?:and|or)\s/i.test(after) && !DETERMINER.test(last))) return false;
    if (match[0].length === 3) return true;
    const window = clause.slice(-3);
    const unit = window.findLastIndex(word => UNIT.test(word.replace(/[.,]$/, "")));
    return POINTER.test(window.slice(unit + 1).join(" "));
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
