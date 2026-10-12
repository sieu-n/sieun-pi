---
name: create-verification-skill
description: "Generate a project-local `verify-<app>` skill that launches the app, drives it the way a user does, and captures proof. Works for any language, framework, or platform. Use for `create-verification-skill`, \"make a control skill for this repo\", or when a project has no scripted way to prove UI, CLI, or service behavior."
disable-model-invocation: true
---

# Create a verification skill

Write `.prime/agent/skills/verify-<app>/` in the target repo. Its reader is an agent that has never seen the app and opens the skill mid-task.

## 1. Interview the repo

Answer these questions from the code. Ask the user only what the code cannot show.

- What does a user touch: a web UI, a CLI or TUI, a desktop app, an API, a mobile app, or a library? Pick the primary surface and note the others.
- How does the app start locally? Use the repo's own dev command from package scripts, a Makefile, or the README, and note ports, env vars, seed data, and auth.
- How can an agent drive it? Use an existing harness first, such as the repo's e2e specs, expect scripts, PTY helpers, HTTP endpoints, or a debug port. Otherwise use the `aside-browser` skill for a browser, a tmux or PTY session for a CLI or TUI, and plain HTTP for a service.
- What evidence can you capture: screenshots, terminal transcripts, response bodies, logs, exit codes, or database state?
- Can two instances run side by side with separate ports, data dirs, and profiles? If not, the generated skill must refuse to drive an instance it did not start.

If the checkout does not build or start, fix it or report the exact failure before you generate anything. If a missing asset that the feature does not use blocks startup, the generated skill may create it as marked scaffolding and remove it during cleanup.

## 2. Write the skill

`SKILL.md` needs frontmatter with `name: verify-<app>` and a `description` that names the app, the surface, and when to use it. Fill every section below with real commands and handles from the interview. Leave no placeholders.

### Launch

Give the exact start command, the ready signal (a log line, an open port, or a prompt), and the teardown command. A short-lived CLI or TUI has no server: build the binary or install deps once, then run each drive in its own PTY or tmux session.

### Doctor

Give one read-only check that the instance is worth driving: the process is up, the build is the expected one, the port belongs to this run, and auth works. The agent runs it first and again whenever something looks wrong.

### Drive

Give the harness recipe with this repo's real selectors and commands. Use stable handles such as ARIA roles and names, data attributes, prompt strings, and route paths. Do not use coordinates or tab order.

### Evidence

Say what to capture and where to write it. Drive the real user path, never internal setters or test-only endpoints. Capture the action and the resulting state. Check side effects such as written files, inserted rows, and sent messages. Mock only at a boundary that production already isolates. If the safe path is a dry-run or test mode, observe files, network, and git refs to confirm what it skips, because some dry-runs still hit the network or open a browser.

### Cleanup

Stop only the processes this run started, never by process name. Remove instances and scratch state, and keep the proof artifacts at the location the skill names.

### Helpers

Make every shipped script executable and show its invocation in `SKILL.md`.

## 3. Seed the feature map

Create `features/README.md` in the generated skill, plus one file for each of the top 3 to 5 user-facing features you find in routes, commands, menus, or docs. Copy the shape of [`references/feature-map-example/`](references/feature-map-example/). Each feature file uses these four H2 sections in order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with <harness>`
4. `Gotchas`

The map is the list of what to verify. A proof that drives one entry point is incomplete when the map lists others.

## 4. Run the generated skill once

Follow its instructions end to end: launch, doctor, drive one mapped feature, capture evidence, and clean up. After cleanup, confirm the evidence still exists at the named location. Fix each failure, and run the generated cleanup after every failed attempt so no process or port is left behind. Hand the skill over only after a full run passes.

## 5. Tell the user when to rerun

Tell the user to rerun this skill when the app changes and the map drifts.
