### Eval

For testing how a skill, structure, or prompt change affects agent behavior before you adopt it. Candidates must not know they are being tested.

#### Blinding rules

- Keep these words out of every directory, file, and prompt a candidate sees: eval, test, judge, experiment, rubric, score, compare, benchmark, candidate, arena.
- Write the candidate prompt as an ordinary user request, such as "build me a small todo cli".
- Do not ask candidates which skills or principles they used. Grade that from the files they opened and the code they wrote.
- Name directories the way a user would, not `candidate-1` or `agent-a`.
- Do not tell a candidate that other candidates exist.
- Show the judge outputs under neutral labels, never model names.
- When you compare two variants, one judge scores both sets in one pass on one scale.

#### Steps

1. Name the variant under test and what success looks like. Write a rubric of 3 to 6 concrete criteria for the judge only.
2. Give each candidate its own working directory with the variant in place and the context a real task would have.
3. Write one ordinary prompt and give it to every candidate.
4. Spawn the candidates on different models per Phase B of the arena skill.
5. Spawn one blind judge on a different model family per Phase C of the arena skill.
6. Read each candidate's transcript at `~/.prime/agent/session-artifacts/<this-session-id>/sub-<child>/<child-id>.jsonl`, or preview it with `await agent_observe.recent_messages(<child-name>)`. Do not search `~/.prime/agent/sessions/`, which holds other projects' chats. Grade from the files each candidate opened and the code it wrote.
7. Read every output yourself and compare it with the judge. A disagreement means a biased model or an unclear rubric.

Reply with the variant, the rubric, notes per candidate, the judge's verdict, your synthesis, and whether to adopt the variant.
