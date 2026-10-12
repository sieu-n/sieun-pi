# Epistemics

Every why answer follows these rules. Code shows what it does; only something a person wrote shows why.

## Confidence tiers

Put every claim in one tier. The tier decides the output section and the wording.

| Tier | When | Wording | Example |
|---|---|---|---|
| Direct | An author wrote down the reason | Plain "because", with the citation next to it | A comment says `// clamp to 100 because the upstream API rejects larger values` |
| Supported | Several indirect items agree, none states it | "The evidence points to X", listing each item | PR title says "improve performance", the ticket has a `perf` label, and nearby commits touch the same hot path |
| Inferred | A fair reading of context, with nothing stating it | "appears to", "likely", "suggests", "is consistent with", plus the chain "given A and B, C is likely" | Merged the same day as an incident thread, so it was likely a hotfix |
| Speculative | Thin evidence, and other stories fit as well | "One possibility is X, but we found no direct evidence" | The threshold may match an SLA, but no SLA doc names it |
| Unknown | You searched and found nothing | "We searched A, B, and C for X and found no rationale" | Name each source and each query |

Use "because", "the reason is", "was designed to", "fixes", and "the team decided" only for Direct or Supported claims.
Do not write "obviously", "clearly", "of course", "just", "I think", or "I believe".

## Rules

1. Cite every claim with a commit hash, PR number, ticket ID, doc URL, chat permalink, or file:line.
2. A claim without a citation is Inferred or Speculative, never Direct.
3. Never cite the code as evidence for its own intent, because "it checks for null, so it handles null" only describes mechanics.
4. Do not infer intent from code style, names, or a pattern repeated across the codebase, which may be copy-paste.
5. When two sources disagree, show both with their citations and do not pick one.
6. When the evidence fits several stories, list each one with the evidence for and against it.
7. Treat a reason the user suggests ("I assume it is for performance?") as one hypothesis and check it like the others.
8. Do not assume the author did the right thing and work backward to justify it.
9. Do not read a missing mention as proof that a concern did not exist.
10. Do not assume the latest commit explains the shape; trace back through earlier changes.
11. Name every gap with the question, the sources searched, the queries run, and what came back.

A clear "we could not find out why" tells the user to ask the author or product owner. A confident guess in its place misleads them.

## Check before you finish

1. Every claim in "What we found" has a citation, or it moves to "What we can infer" or "Competing hypotheses".
2. Every claim's wording matches its tier.
3. No claim cites the code as evidence for its own intent.
4. "What we don't know" exists and names specific gaps, since an empty one usually means something was missed.
