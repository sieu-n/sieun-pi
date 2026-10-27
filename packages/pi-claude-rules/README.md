# pi-claude-rules

This extension loads a repo's `.claude/rules/*.md` files the way Claude Code does, in Prime Agent sessions today and in Pi sessions.
Until 10-28 it lived in `components/claude-rules`. Prime itself loads only AGENTS.md, so until 10-25 no Prime session saw auto-sns-agent's 25 rule files, and every top test adder since 10-21 was a Prime session that never read `testing-rules.md`.

## When a rule loads

1. A rule file with no `paths:` front matter loads at session start, for the repo that holds the session cwd.
2. A rule file with `paths:` globs loads the first time the session reads or edits a file that one of its globs matches, once per session.
3. A session started outside a repo, such as a chat job started in home, gets that repo's unscoped rules with its first touch of a file there.
4. A compaction drops the appended rules from context, so a rule loads again on its next match after one.

Globs are relative to the folder that holds `.claude/`. `**` spans folders, `*` and `?` stay inside one, and `{a,b}` picks one, as in Claude Code. `paths:` takes a YAML list or one comma-separated string.

## How it reaches the model

The unscoped rules go in one message that the `context` hook puts first on every model call. The text is read once per session, so the cached prefix stays the same on every turn kind, agent-message wakes included, and after a compaction.

A scoped rule is appended to the result of the tool call that touched its file, and a `claude-rules` custom entry records it, so a reload, resume or fork does not load it twice. Earlier context never changes.

The extension finds touched files in the `path` or `file_path` input of a tool, a `bash` command, and an `ipython` cell. In a cell it reads each path the code spells out against the cwd that part of the cell runs in, with `cellStart` and `cellSteps` from `packages/sieun-rules/src/kernel-cwd.ts`, whose kernel prelude reports the kernel's cwd. A path the cell builds at run time, such as one read from a variable an earlier cell set, does not count.
That cwd tracking is sieun-rules' code, so `src/pi/index.ts` imports it from the sibling folder `../sieun-rules` when it is there, as in this repo and every runtime release. Installed alone, the package reads a whole cell in the session cwd, and the `path`, `file_path` and `bash` inputs work as before.

`CLAUDE_RULES=off` turns the extension off for a process. A load error goes to the global-rules log.

## Cost

auto-sns-agent's seven unscoped rules are 49,917 characters. On 10-25 two `prime-agent -p` runs in that checkout on claude-opus-5-5, with `CLAUDE_RULES=off` and without it, wrote 15,128 and 34,042 cache tokens on their first call, so the rules cost 18,914 tokens, written once per session and read from cache after that. Reading a file under `apps/crawler-v3` appends `app-crawler-v3.md`, which is 92,269 characters on its own.

## Install alone into stock Pi

The package needs nothing but Pi itself.

```sh
pi install ./packages/pi-claude-rules   # adds it to Pi's settings, loads src/pi/index.ts in place
pi -e ./packages/pi-claude-rules        # one run only, no settings change
```

## Layout

| Path | What it holds |
|---|---|
| `src/core/rules.ts` | Rule parsing, glob matching, the touched-path reader and the `context` and `tool_result` hooks. |
| `src/pi/index.ts` | The extension entry, which Prime loads through `~/.prime/agent/extensions/claude-rules.ts` and Pi through `pi.extensions`. |
| `test/rules.test.mjs` | The rule loading tests, run by `npm test` here and by the repo's `scripts/check.mjs`. |
