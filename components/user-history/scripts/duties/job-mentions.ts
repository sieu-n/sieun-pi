/**
 * The Chat health `unlinked_job_mentions` matcher. Owner (10-09): "씨발 무슨job인지 말해줘야될거 아니니^^" (you have to tell me which job it is).
 * A message to the owner that mentions a job as a noun ("a job", "the job", "jobs") must name it with a `job:<name>` link somewhere in it.
 */
const JOB_WORD = /(?<![\w:/.-])jobs?(?![\w:/-])/i;
/** Text the owner does not read as prose: code spans and blocks, and markdown link targets. */
const NOT_PROSE = /```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)/g;

/** The sentence that mentions a job with no `job:` link in the whole message, or null. */
export function unlinkedJobSentence(text: string): string | null {
  if (/\bjob:/i.test(text)) return null;
  const prose = text.replace(NOT_PROSE, " ");
  if (!JOB_WORD.test(prose)) return null;
  const sentences = prose.split(/(?<=[.!?])\s+|\n+/);
  return sentences.find(sentence => JOB_WORD.test(sentence))!.trim();
}
