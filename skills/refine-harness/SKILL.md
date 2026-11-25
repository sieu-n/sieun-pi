---
name: refine-harness
description: "Use when the owner gives feedback, a correction or a decision that should outlast the turn, when you call refine.run, rlm.harness or correction_add, when a [skill-route] notice arrives, and every time you add, remove or install a skill. Says where each lesson goes (agent memory and its wiki page, a skill, an AGENTS rule, the corrections ledger or nowhere), with real cases, exact paths, how to edit, add or remove a SKILL.md with the sw skills commands, and the blind check that ends the change."
---

# Refine the harness

Memory and skills both write prompts ahead of time, so the scope of a lesson decides where it goes.
The owner set the split on 11-20 in #sw-factory-build p110: a decision about one product or scope goes to the agent's memory and its wiki page, and a general standard, above all a coding standard or a harness decision, changes a skill.

## Where a lesson goes

| The lesson | Where it goes | Real case |
|---|---|---|
| A decision about one product, project or agent | The agent's memory, and the wiki page of that product | Mark unread pins the post in a Keep unread stack (p87, p96) is in agent factory's memory. |
| A fact about how one system works | The agent's memory | pi and Prime compact at 483,616 tokens is in agent factory's memory. |
| How every agent writes or behaves in a room | `skills/sw-factory/SKILL.md` and the comm role text, through agent factory's work thread | "never paste a raw JSON line" is in the role text in `packages/pi-host/src/durable/agent-profile.ts`. |
| A coding, review or writing standard for one area | The skill that owns that area, such as `typescript-best-practices`, `unslop` or `wiki` | A rule for how wiki pages read belongs in `skills/wiki/references/writing.md`. |
| A standard for one repo's code or UI | That repo's AGENTS.md, or a skill in its `.agents/skills/<name>/` | c195, no two cards side by side that end at different lines, belongs in the 5180 app repo's UI rules. |
| A rule for every Prime session that no skill owns | `config/AGENTS.md` in sieun-pi | Rule 6 there, the `heavy` wrapper for big test runs. |
| An owner correction of how chats or jobs work | The corrections ledger with `correction_add`, plus the skill or brief that holds the rule | c191, keep a count the user sees exact, reaches every chat as a `[corrections]` line. |
| A fact every agent needs about a shared tool or box | Global memory, `rlm.harness.create_memory(..., global_=True)` | prime-sync fast-forwards every box each minute. |
| A task, a one-off answer, step status or progress | Nowhere, or the board | "post the screenshot in this thread" is a task. |

Four cases look alike and are not.

1. "When you list options, explain the most interesting one properly" (p97) was said to agent factory, but it is how every agent writes, so it is rule 11 of the sw-factory skill, the options rule. Agent factory keeps its own case in memory as well.
2. c195 came from one app screen, but it holds for every screen of that app, so it goes into that repo's rules and not into the job's memory.
3. A rule about one agent's product, such as how vent triages an alert, stays in that agent's memory even when it is strict and repeated.
4. When a general rule moves out of an agent's memory into a skill, rewrite the entry as the agent's own case and keep it, never delete it. On 11-20 a move deleted seo's copied-cookies incident and search-product-misc's c226 and c191 entries, and the next d3 memory run found all three lost from their ideal in `~/work/agent-memory/ideal.json`.

To decide, ask whether another agent or repo would make the same mistake. If yes, the lesson is general and goes into a skill or an AGENTS rule.
A global prompt note is never the place for a general standard, because a note reaches only the digest, ranks out of sight among a hundred others and gets no review in a commit.

## Paths

- An agent's memory is `~/.pi/agent/agents/<slug>/harness/harness_state.json`. From that agent's thread, run `rlm.harness.search(...)` and then `update_memory` or `create_memory`, or call `POST :5184/api/agents/<id>/memory`.
- The global store is `~/.prime/agent/harness/harness_state.json`, and `global_=True` writes it.
- A wiki page is written with the wiki skill's `wiki.write(...)` under the product's domain page.
- A shared skill is `/home/sieun/src/sieun-pi/skills/<name>/SKILL.md`. prime-sync links it to `~/.prime/agent/skills/<name>` on every box about a minute after it reaches `main`, and pi-host loads that folder too. The skills DB in sw factory's `chat.sqlite` records which skills exist, who owns each and where each is installed, and `sw skills` reads and changes it.
- The rules every Prime session reads are `/home/sieun/src/sieun-pi/config/AGENTS.md`.

## Editing a skill

1. Find the skill that owns the area and read it in full, so the rule lands in its section.
2. Make the smallest change, usually one numbered line with the owner's words and the post or correction id. Never make a new skill for one rule (c99).
3. Change code defaults and tool text first when they carry the behavior, and the skill second (c130).
4. Commit only your file with `git commit -m "<what agents now do>" -- skills/<name>/SKILL.md` in the one checkout, then push to `main`.
5. Only a work thread or a job edits and commits. A comm thread has no edit tool, so it hands the rule to its work thread, and a rule about how agents write in a room goes to agent factory.
6. The change is done when a blind fresh session, given the owner's real kind of ask with no steering, follows the rule (c84). The sw-factory skill has the scripts for room behavior.

## Adding or removing a skill

The text of a skill lives in git, and its row, owner and installs live in the skills DB, so a new or deleted skill takes a commit and a `sw skills` command.
Prime's skill-creator skill gives the frontmatter and layout rules, but its locations do not apply here: a folder under `~/.prime/agent/skills` or `~/.claude/skills` that no row owns shows as `unowned` drift.
Nobody writes a skill's verdict by hand, because the chat server's hourly scan runs the rules in `apps/chat/server/skills-model.ts`, which mark each skill duplicated, outdated, bloated or never used (p146).

1. To add a skill, write `skills/<name>/SKILL.md` in `/home/sieun/src/sieun-pi`, add `<name>` to `install-manifest.json` and `package.json`'s skill list, commit only those files and push to `main`.
2. Wait a minute for prime-sync to link it on each box, then run `sw skills scan --wait` and `sw skills adopt us-metal02:/home/sieun/src/sieun-pi/skills/<name>`. The adopt makes the skill's row and takes the links that already point at it.
3. Set the owner with `sw skills own git:sieun-pi/skills/<name> <agent id>` when the skill is not agent factory's.
4. To remove a skill, delete its folder and its two manifest entries in one commit and push it. After the next scan, `sw skills check` lists the skill as `gone`, and `sw skills remove git:sieun-pi/skills/<name>` drops its row and installs and leaves old clones alone.
5. To install a skill for another runtime, such as Claude Code, run `sw skills install <name> --box <box> --runtime claude`, never a hand-made link or copy.
6. The change is done when `sw skills check` prints "No drift". Agent factory's d3 duty reads the same check every day.

## How refine routes a general standard

In a pi-host thread, the refine planner returns a general standard as a `skillRoutes` item with its target file instead of a memory or a prompt note. pi-host then hands the thread's root a `[skill-route]` input, also for an auto-refine and for a job's refine, and that thread makes the edit as above.
A walk's test agent (`POST /api/agents {test: true}`) gets no route, its refine writes only its own store, and its kernel's `global_=True` writes land in a copy of the global store in its folder, because on 11-21 a blind run's test agent took a route and pushed d87524e0, a config/AGENTS.md change for every agent.

Prime's own `refine.run` is upstream. Its planner cannot edit a file or return a route, so in a Prime chat make the skill edit yourself in the turn that taught it, and call `refine.run` only for a fact or a local decision.
