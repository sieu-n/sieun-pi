/**
 * The `unlinked_job_mentions` matcher: Chat health counts with it. Owner (10-09): "씨발 무슨job인지
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
