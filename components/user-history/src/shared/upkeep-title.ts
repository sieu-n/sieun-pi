/**
 * The words that make a plan title read as upkeep instead of a task that finishes, or null. The owner on 10-19 (msg mvfb7zt0): "things like
 * 'i need to keep X working' should NOT be registered as a zombie plan. ALL PLANS SHOULD BE EPHEMERAL", after the AI harness chat's goal
 * "Every duty in every chat is green" sat open at 102 of 109. Upkeep is a duty metric (board skill, references/plan-and-duties.md). Only the
 * main clause counts, because a purpose after "so" or "instead of" belongs to a task. A title that opens with a task verb counts only for an
 * "and keep it current" tail, the upkeep half of a mixed request.
 */
export function upkeepWords(title: string): string | null {
  const main = title.split(PURPOSE)[0] ?? title;
  return (TASK_VERB.test(main) ? AND_KEEP : UPKEEP).exec(main)?.[0] ?? null;
}

const STATE = "(?:healthy|up|green|clean|usable|current|fresh|in sync|working|running|reliable|alive|online|empty|fast|safe|quiet)";
const STATE_END = "(?=$|[,.:;]| and | across | through | when | with | on | every )";
const UPKEEP = new RegExp(`^\\s*keep(?![-\\w])|\\bkeeps? (?!up\\b)${STATE}\\b|\\bkeeps? (?:[\\w'-]+ ){1,3}?${STATE}${STATE_END}|\\bstay(?:s|ing)? ${STATE}\\b|\\balways (?:be |stays? |is |are )?${STATE}\\b|` +
  `\\bevery\\b[^,:;]*?\\b(?:is|are|reads?) ${STATE}\\b|\\bkeeps? working\\b`, "i");
const AND_KEEP = new RegExp(`\\band (?:keeps?|stays?) (?:[\\w'-]+ ){0,3}?${STATE}\\b`, "i");
const PURPOSE = /,? so (?:that )?|,? instead of |,? while |,? after /i;
const TASK_VERB = /^\s*(?:fix|build|add|make|find|verify|check|rank|ship|plan|decide|restart|run|start|update|push|lift|re-?measure|post|file|move|write|measure|set|turn|get|test|land|remove|drop|cut|split|wire|show|give|send|follow[- ]up|research|design|investigate|audit|migrate|replace|rewrite|port|install|create|open|close|delete|stop|clean up|re-?run)\b/i;
