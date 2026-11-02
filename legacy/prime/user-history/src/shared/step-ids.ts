/**
 * The plan step and todo ids (`p67`, `t8`) a free text such as a waitFor names on its own board, in order, each once. Every check that reads
 * the ids of a wait uses it: wait_met (`waitsMet`), the ready review (`waitOver`), the fold home (`goalFolds`), the carrier and host hold of the
 * end state (`stepCarrier`, `waitHolds`), d9's `waitsOnStep` and the other-board refs (`waitRefs`). Each caller looks the id up on its board, so
 * an id the board lacks names nothing.
 *
 * A percentile word (p50, p75, p90, p95, p99) is a latency, never a step: Crawler VP's p1131 waited for "... raising lookup concurrency if drain
 * search_ms p50 is back near its 10-31 level ...", and the 05:06Z and 07:06Z check-ins on 11-02 read done step p50 as its wait over, after
 * p1057's "cold p95 2.5 s" had done the same on 10-28. On 11-02 every board's 17 percentile words in a waitFor were latencies.
 *
 * An id inside a ref ("ci/queue-cuts-t9", "p0/p1") is part of a name, and so is one after a hyphenated name with a number ("land-39 p3"):
 * Crawler VP 10-16 p535 waited for "land-39 p3 20880ecc10 green" and read done goal p3.
 *
 * `dropAfterName` also drops an id right after a name word ("queue cuts t9", "cut p1022"), which wait_met needs because it reads a wait as over
 * only when every id it names is closed: VP of CI 10-14 p135 waited for "run 38414179195 (queue cuts t9 on f0a8ed462f) green", and four
 * check-ins read that t9 as answered todo t9. An id still counts standalone or after a small word ("todo t9", "For you t9", "on t18", "p8 and
 * p9"), and a name word in an open bracket counts as the word ("(cut p1022"). The checks that look for what a step waits on keep such an id,
 * since "ships inside p980's deploy" waits on p980.
 */
export const PERCENTILE = /^p(?:50|75|90|95|99)$/;
const SMALL_WORDS = new Set(["a", "the", "on", "of", "for", "to", "at", "in", "by", "from", "after", "before", "until", "till", "with", "and", "or",
  "nor", "plus", "then", "see", "also", "via", "once", "when", "while", "both", "is", "are", "was", "were", "answer", "answers", "answered", "await",
  "awaits", "wait", "waits", "you", "todo", "todos", "step", "steps", "plan", "goal"]);
export function stepIds(text: string, { dropAfterName = false }: { dropAfterName?: boolean } = {}): string[] {
  return [...new Set([...text.matchAll(/\b[pt]\d+\b/g)].filter(({ 0: id, index }) => {
    const before = text.slice(0, index);
    const word = (/(\S+)\s+$/.exec(before)?.[1] ?? "").replace(/^[("'\u2018\u201c[]+/, "");
    return !PERCENTILE.test(id) && !/[-/_.]$/.test(before) && !/^(?:[-/_]|\.\w)/.test(text.slice(index + id.length)) &&
      !/^[a-z]+-\d+[a-z]?$/i.test(word) && !(dropAfterName && /^[a-z]+$/i.test(word) && !SMALL_WORDS.has(word.toLowerCase()));
  }).map(([id]) => id))];
}
