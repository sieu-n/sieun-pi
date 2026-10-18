---
name: unslop
description: "The writing standard. Use for any text a human will read: replies, reports, commits, docs, specs, tickets, and articles."
---

# Unslop

Apply this to any text a human will read. Published text matters most, because an SEO article or landing page shows its slop to every visitor and stays up. Do not announce that you applied this skill, and do not print a checklist. Return the cleaned text only.

This file is the one writing standard. If another writing rule disagrees, this file wins.

llm-wiki pages add the 메르 style, and a subagent writes each page. The body is numbered short lines, one plain sentence each, with a mermaid diagram or image for every flow, structure or comparison, short sections, and no prose paragraphs. That standard lives only in auto-sns-agent's `.agents/skills/apps/llm-wiki/references/writing.md` (read it with `node scripts/skills/read-skill.mjs apps/llm-wiki/references/writing.md`), and `apps/llm-wiki/scripts/prose-lint.mjs` enforces both files on every page write and commit.

## The one test

Read the sentence once at speech pace. If a reader would re-read it to parse it, or reach for a dictionary, rewrite it with the common word. Any word that slows the transfer of the fact is a defect.

## Formatting and punctuation

Run this pass first. It catches the most hits.

1. Use no em dashes. End the sentence or use a comma. Do not swap in parentheses, en dashes, or a spaced hyphen.
2. Use a colon only to introduce a list or an example. Never use one as a mid-sentence connector or a reveal ("The best part: it learns").
3. Use bold inside a paragraph only for a short label, under about 40 characters, with 2 or 3 bold spans in a message. Italics for emphasis are the same defect.
4. Let no label open a paragraph or a bullet. A bold lead-in (`**Layer 1, LLM proxy.** As in...`), a colon label (`**Runbook:** the runbook...`, `Live now: ...`) and a bold sentence dropped mid-paragraph are all out.
5. Make every bullet one normal, complete sentence with a subject and a verb, ending in a period. No fragments, no `label: value` pairs, and no clauses stuffed together with semicolons or comma chains. Two ideas are two bullets. In chat and docs, use a list only for parallel items and write everything else as a paragraph. An llm-wiki page body is the exception described above.
6. Write headings in sentence case. Use no decorative emoji, and only straight quotes.
7. Use numbered lists for sequences. Link text names where the link goes, never "click here".

## Headers and writing about your own work

8. A header or bullet label says what it contains, never how to feel about it. Rejected before: "The most durable win", "the finding to keep", "The uncomfortable parts, kept", "answered honestly". Accepted: "The gold ceiling moved, 68.2% to 72.9%", "Nine defects in the labeller itself".
9. Never announce that you are being honest or transparent, or that a caveat is uncomfortable. Cut "The honest answer to..." and "stated with its limits". State the limit in one sentence and move on.
10. Never compress a measurement into a slogan. Write the words a coworker would say out loud. Not "supply transferred across four frames and ranking did not", but "finding new addresses worked on all four test sets; re-ordering addresses we already had only worked on the one it was built from".
11. Do not praise your own work ("the right call", "the sharpest example", "earned its way in"). Report what changed and what it cost.
12. Keep real names verbatim: recall_strict, e2e_yield, p-value, and every real file, commit, run, and arm name. Only the narrative around them has to be plain.

## Words

13. Use the word a coworker would say out loud: start (not commence), use (not utilize or leverage), end (not terminate), fix (not remediate), after (not subsequent to), before (not prior to), enough (not sufficient), way (not methodology), help (not facilitate), if (not in the event that), to (not in order to), because (not due to the fact that).
14. Do not use these words: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, seamless, comprehensive, pivotal, holistic, myriad, additionally, crucial, enhance, enduring, garner, interplay, showcase, testament, underscore, landscape (as an abstract noun), vibrant.
15. Do not use marketing words: easy, simple, simply, quick, powerful. Write the concrete fact, such as "one command".
16. Cut empty qualifiers and adverbs: very, just, really, actually, essentially, exactly, arguably, significantly, typically, generally, fundamentally, importantly, strictly. If a quantity matters, give the number. An adverb that props up a weak verb means the verb is wrong.
17. Repo names beat the banned lists. `browser-harness.mjs` stays "the browser harness". "harness the power of" does not.

## Sentences

18. Use active voice and name the actor. "The lock is acquired" becomes "the wrapper takes the lock".
19. Let verbs do the work. "made a decision" becomes "decided". "serves as", "boasts", "features", "provides", and "offers" become "is" or "has", or say what it does in this flow.
20. Keep sentences to about 20 words and one idea each, but vary the length on purpose. All clipped reads as machine-made as all long.
21. Apply the portability test. If the sentence could move unchanged into another project, it says nothing about this one. Replace it with a fact, number, path, or consequence: "improves efficiency" becomes "cut deploy time from 40 min to 4". Say what a thing does, not how it feels: "SQL you can read" becomes "`.toSQL()` returns the exact string sent to the database".
22. Machines do not do human-physical actions. "the token holds" becomes "the token stores".
23. Put the condition before the instruction: "To delete the document, click Delete." Write instructions as commands, one per sentence.
24. Keep "only" and "not" next to the word they change. Make every "it" and "this" point at one obvious noun, and keep "the" and "a".
25. Make every count, path, and symbol true at the commit that lands it, and give the command that regenerates a count.

## AI-tell patterns, cut on sight

26. Cut importance puffery such as "plays a vital role", "marks a pivotal moment", and "setting the stage for". State the fact.
27. Cut binary contrasts such as "It's not X, it's Y" and "not just X but Y". State Y.
28. Cut faux insight such as "here's the thing" and "what most people miss".
29. Cut meta-narration such as "this section describes", "as mentioned", "it's worth noting", and "let's look at".
30. Cut -ing clauses that pretend to explain, such as "..., highlighting the team's commitment". Write the real consequence or delete the clause.
31. Cut weasel attribution such as "studies show". Name the file, log, measurement, or person, or cut the claim.
32. Call one thing by one name. Pick the code's name and repeat it instead of cycling through "the wrapper", "the runner", and "the tool".
33. Do not force ideas into groups of three or build alliterative triples. Use the natural number.
34. Do not write "from X to Y" when X and Y are not on a scale. List the items.
35. Cut hedging. "could potentially be argued that it might" becomes "may", or the measurement.
36. Cut chatbot phrases such as "I hope this helps", "Let me know if", "Certainly", "Great question", and "You're absolutely right". Answer directly.
37. Cut cutoff disclaimers ("While specific details are limited") and generic conclusions ("The future looks bright"). Find the fact, or state the plan or the number.

## Invented jargon and abstract metaphor nouns

38. Use repo jargon the code names, such as `frontier` or `CAS`. Do not invent dramatic words for ordinary things: "epilogue" for cleanup, "the spine" for a module list.
39. Replace abstract metaphor nouns with the plain word: substrate (base), wedge in (add), vector (way), locus, vantage, nexus, primitive as a noun, harness as a metaphor, surface as in "API surface", bedrock, scaffolding, modality, gold-plating (more than the job needs), ratchet (the real mechanism name, or "a limit that only tightens"), evacuate (move out), endgame (the last phase), north star, flywheel.
40. The portability test is the rule, and the lists only give examples. "Gate the parcel, not the desk" is on no list and still says nothing. Name the mechanism: "lint the commit being pushed, not the working tree".

## Failure reports

Every failure report carries all five, in this order.

41. The service and its address.
42. The exact status codes or exception types, with counts.
43. How many units of work failed, and how the failures split by kind.
44. Whether it works now, with a measured number.
45. Your own contribution, before any vendor blame.

Never use a vague noun for the failing thing: "the gateway", "infra", "capacity", "transport". State what happened, not a rounded story. If one run failed and two later probes hung, say that. Do not compress it into "both attempts".

## Specs and tickets

A spec or ticket should read like the owner typed it in a minute. Model: auto-sns-agent SPEC-13.

46. The title says what works: "Every link on the landing page opens."
47. Notes are 0 to 3 short lines with only what the tester needs: account, target, known blocker. No background story, dates, commit ids, decision codes, session links, or "planned checks" lists.
48. One criterion is one short line, about 15 words, starting with `Local:`, `Staging:` or `Production:`. It says what a person would see. No tool lists, no reasons, no "(60 today)".
49. Evidence goes elsewhere. Put the audit, numbers and history in the session report and link it once if needed.

## Self-audit before sending

Ask "what makes this obviously AI generated?" and fix it. Then count:

- The text has 0 em dashes.
- The text has 3 or fewer bold spans, none longer than about 40 characters.
- Each heading is sentence case and names its contents.
- No sentence could be pasted unchanged into another project.
- No sentence praises your own work.
