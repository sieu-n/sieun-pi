---
name: unslop
description: "The single writing standard for this user. Cut AI tells from any text before sending it. Always apply to chat replies, reports, commits, PR bodies, and every published article - llm-wiki pages, SEO articles, landing page copy, blog posts, and docs. Any text a human will read, including text written by scripts/seo-agent or into apps/llm-wiki/content. Merges pstack's unslop with the user's own writing rules and the auto-sns-agent plain-language file, so there is one standard and not two."
---

# Unslop

## When this applies

Always, to any text a human will read. Named surfaces, because these are the ones that get missed:

| surface | where |
|---|---|
| chat replies and status reports | this conversation |
| llm-wiki articles | `apps/llm-wiki/content/**` |
| SEO articles | anything written by `scripts/seo-agent` |
| landing and marketing copy | `apps/search` public routes |
| blog posts and docs | any `.md` meant for a reader |
| commits and PR bodies | `commit.mjs` messages, PR descriptions |

Published articles are the highest-stakes case. A slopped chat reply costs one reader a moment.
A slopped SEO article or landing page ships the slop to every visitor and stays up.

Do not announce that you applied this skill. Do not print a rule checklist before the text.
Return the cleaned text only.

One standard for every word sent to this user. It merges three sources:

- pstack `unslop` (31 rules), for the formatting and punctuation tells.
- `auto-sns-agent/.agents/skills/apps/llm-wiki/references/plain-language.md`, for words and
  sentence mechanics. Read it with
  `node scripts/skills/read-skill.mjs apps/llm-wiki/references/plain-language.md`.
- The user's own prompt notes `writing_no_editorialising_headers_or_slogans`,
  `plain_language_applies_to_chat_not_just_wiki`, and
  `failure_reports_name_component_error_and_own_cause`.

If any of those seem to disagree, this file wins. Do not maintain a second writing standard.

## The one test

Read the sentence once at speech pace. If a reader would re-read it to parse it, or reach for a
dictionary, rewrite it with the common word. A sentence's job is to move one fact. Any word that
slows the transfer is a defect, however precise it feels.

## Process

1. Write the draft.
2. Run the formatting pass. It is mechanical and catches the most hits.
3. Run the words and sentences pass.
4. Self-audit: "what makes this obviously AI generated?" Fix what is left.

## Formatting and punctuation

Measured on 4,237 words of real output for this user: 75 em dashes, 94 bold spans, 30
mid-sentence colons. This section is where the hits are. Run it first.

1. **No em dashes.** Not one. End the sentence or use a comma. Do not swap in parentheses, en
   dashes, or a spaced hyphen; that trades one tell for another. Two em dashes in a sentence is
   the loudest tell in the language.
2. **Colons introduce a list or an example.** Never as a mid-sentence connector, and never as a
   reveal ("The best part: it learns"). Write the plain sentence.
3. **Bold inside a paragraph marks a short label, nothing else.** Bolding a clause or a whole
   sentence to make it sound important is the slogan rule in markup form. Keep mid-paragraph bold
   under about 40 characters, and aim for 2 or 3 bold spans in a message.
4. **A bold lead-in that opens a paragraph is exempt from the length limit, if it ends in a
   period.** `**Dev transition, 18 of 19 retired tables verified empty.** clearProspects was...`
   is fine and keeps a status report scannable. Two shapes are not: `**Runbook:** the runbook now
   covers...`, where the colon label restates the line, and a bold sentence dropped in the middle
   of a paragraph for emphasis.
5. **Sentence case headings.** No title case.
6. **No decorative emoji.** Not in headings, not as status ticks in bullets.
7. **Straight quotes only.** No curly quotes or apostrophes.
8. **Italics for emphasis are the same defect as bold.** Use the word order instead.

## Headers and writing about your own work

From the user's note `writing_no_editorialising_headers_or_slogans`.

9. **A header or bullet label says what it contains, never how to feel about it.** Banned shapes,
   all of them produced and rejected before: "The most durable win", "the finding to keep", "the
   one X that survived the night", "the cleanest finding of the round", "The uncomfortable parts,
   kept", "The one thing I would carry forward", "answered honestly". Correct replacements from
   the same pages: "The gold ceiling moved, 68.2% to 72.9%", "Agency addresses: four attempts, no
   solution", "Nine defects in the labeller itself".
10. **Never announce that you are being honest or transparent, or that a caveat is
    uncomfortable.** No "The honest answer to...", "stated with its limits", "the honest framing
    is". State the limit in one sentence and move on.
11. **Never compress a measurement into a slogan.** Expand it into words a coworker would say out
    loud. Not "supply transferred across four frames and ranking did not", but "finding new
    addresses worked on all four test sets; re-ordering addresses we already had only worked on
    the one it was built from".
12. **No hollow superlatives on your own work.** "the most valuable act", "the right call",
    "the sharpest example", "earned its way in", "the return on every hour spent tonight". Report
    what changed and what it cost.
13. **Real measurement names stay verbatim.** recall_strict, e2e_yield, p-value, McNemar b/a,
    precision, error rate, and every real file, commit, run, and arm name. Only the narrative
    around them has to be plain.

## Words

14. **Use the word a coworker would say out loud.** start (not commence), use (not utilize or
    leverage), end (not terminate), fix (not remediate), after (not subsequent to), before (not
    prior to), stop (not cease), enough (not sufficient), way (not methodology), help (not
    facilitate), many (not numerous), if (not in the event that).
15. **Banned fancy words.** delve, foster, leverage, utilize, facilitate, empower, streamline,
    robust, cutting-edge, paradigm, tapestry, realm, beacon, multifaceted, meticulous, intricate,
    paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, seamless,
    comprehensive, pivotal, holistic, myriad, additionally, crucial, enhance, enduring, garner,
    interplay, showcase, testament, underscore, landscape (as an abstract noun), vibrant.
16. **Banned marketing words.** easy, simple, simply, quick, powerful. Replace with the concrete
    fact: "one command", "default settings work".
17. **Empty qualifiers, cut them.** very, just, really, actually, essentially, exactly, arguably,
    significantly, typically, generally, fundamentally, importantly, strictly. If a quantity
    matters, give the number.
18. **Cut adverbs or use a stronger verb.** "runs quickly" becomes "is fast" or the number.
    "significantly improves" becomes the measured delta. An adverb propping up a weak verb means
    the verb is wrong.
19. **Repo names beat the banned list.** `browser-harness.mjs` stays "the browser harness".
    "harness the power of" does not.

## Sentences

20. **Active voice.** Append "by monkeys". If it still parses, it is passive; name the actor.
    "The lock is acquired" becomes "the wrapper takes the lock".
21. **Verbs do the work.** "made a decision" becomes "decided". "has the ability to" becomes
    "can". "serves as", "stands as", "boasts", "features", "provides", "offers" all become "is"
    or "has".
22. **About 20 words per sentence, one idea each.** If the reader has to backtrack, split it.
23. **Vary the length on purpose.** One idea per sentence does not mean one length per sentence.
    Short sentences land a point. A longer sentence can carry a fact with its condition. All
    clipped is as machine-made as all long.
24. **Concrete beats abstract, the portability test.** If the sentence could move unchanged into
    another project, it says nothing about this one. Cut it or replace it with a fact, number,
    path, or consequence. "improves efficiency" becomes "cut deploy time from 40 min to 4". "The
    finish line is measured in days" becomes "at ~150,000 posts a day the remaining brands finish
    in three days".
25. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can
    read" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact
    string sent to the database", "a column rename fails the build".
26. **Machines do not do human-physical actions.** "the token holds" becomes "the token stores".

## AI-tell patterns, cut on sight

27. **Importance puffery.** "plays a vital role", "marks a pivotal moment", "underscores", "a
    testament to", "setting the stage for". State the fact; the reader judges importance.
28. **Binary contrasts.** "It's not X, it's Y", "not just X but Y", "not a wrong number but a
    correct one". State Y.
29. **Faux insight.** "here's the thing", "what most people miss". Make the claim stand alone.
30. **Meta-narration and summary transitions.** "this section describes", "as mentioned", "it's
    worth noting", "let's look at", "in other words", "with this setup complete", "now that we've
    explored". Delete and state the point.
31. **Superficial -ing clauses that pretend to explain.** "..., highlighting the team's
    commitment", "ensuring reliability". Replace with the real consequence or delete.
32. **Weasel attribution.** "studies show", "experts believe", "industry reports suggest",
    "widely regarded". Name the file, log, measurement, or person, or cut the claim.
33. **Synonym cycling.** the wrapper, the runner, the tool, the harness for one thing. Pick the
    code's name and repeat it.
34. **Spec-sheet voice.** "provides", "is configurable", "offers". Say what it does in this
    flow.
35. **Rule of three.** Do not force ideas into groups of three, and do not build alliterative
    triples ("Good data, good method, good insights"). Use the natural number. Three real items
    counted from data are fine.
36. **False ranges.** "from X to Y" where X and Y are not on a scale. List the items.
37. **Filler phrases.** "in order to" becomes "to". "due to the fact that" becomes "because".
    "it is important to note that" is deleted.
38. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may", or
    becomes the measurement.
39. **Chatbot phrases and sycophancy.** "I hope this helps", "Let me know if", "Of course",
    "Certainly", "Found the smoking gun", "Great question", "You're absolutely right". Answer
    directly.
40. **Cutoff disclaimers.** "While specific details are limited". Go find the fact or drop the
    claim.
41. **Generic conclusions.** "The future looks bright." State the plan or the number.

## Invented jargon and abstract metaphor nouns

42. **Repo jargon is fine, invented jargon is not.** `frontier`, `quiesce` where the code says
    quiesce, `CAS`: fine, the code names these. Inventing dramatic vocabulary for ordinary things
    is not: "epilogue" for cleanup, "the noise machine" for a worker, "the spine" for a module
    list, "the zero-LLM walker on an unseen frame" for a code-only finder run against a test set
    it was never tuned against.
43. **Abstract metaphor nouns, with their plain replacement.** substrate (base), wedge in (add),
    vector (way, method), locus, vantage, nexus, primitive as a noun, harness as a metaphor,
    surface as in "API surface", bedrock, scaffolding as a metaphor, modality, gold-plating (more
    than the job needs), ratchet (the mechanism's real name, or "a limit that only tightens"),
    evacuate (move out), endgame (the last phase), north star, flywheel.
44. **The list is not the rule.** Rule 24, the portability test, is the rule. "Gate the parcel,
    not the desk" is on no ban list and is still invented jargon, because the sentence could be
    pasted into any repo and would still say nothing. The correct form names the mechanism: "lint
    the commit being pushed, not the working tree".

## Failure reports

From the user's note `failure_reports_name_component_error_and_own_cause`. Every failure report
carries all five, in this order.

45. The service and its address.
46. The exact status codes or exception types, with counts.
47. How many units of work failed, and how the failures split by kind.
48. Whether it works now, with a measured number.
49. Your own contribution, before any vendor blame.

Never use a vague noun for the failing thing: "the gateway", "infra", "capacity", "transport".
State what happened, not a rounded story. If one run failed and two later probes hung, say that.
Do not compress it into "both attempts".

## What was dropped from pstack unslop, and why

- **The whole "Adding soul" section.** It told the writer to have opinions, use "I", "let some
  mess in", and acknowledge complexity, with the worked example "there's something unsettling
  about agents churning away at 3am". That sentence names a feeling, so it is banned by pstack
  unslop's own rule 27 and by the user's note on editorialising. The two survivable pieces are
  kept above: vary the rhythm (rule 23) and be specific over sterile (rule 24).
- **Name-dropping media outlets, promotional travel copy, formulaic "despite challenges"
  sentences.** Journalism failure modes. Zero hits in 4,237 words of this user's real output.
- **The suggestion to cite this file's rule numbers.** Rewrite the text; do not annotate it.

Verification, meaning how you prove a claim rather than how you word it, is a separate rule. See
the prompt note `liveness_checks_probe_the_capability_you_need`. This file does not cover it.

## Self-audit before sending

Count, do not eyeball:

- em dashes: must be 0.
- bold spans: 3 or fewer, none longer than about 40 characters.
- headings: sentence case, each one naming its contents.
- any sentence that could be pasted into another project unchanged: cut it.
- any praise of your own work: cut it.
