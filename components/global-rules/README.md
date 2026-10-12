# global-rules

This Prime Agent extension holds the rules that apply to every session on this Mac, whatever the session's cwd is.
Repository rules do not live here. A repository ships its own guard as a project-local extension under `<repo>/.prime/agent/extensions/`, and Prime loads it only for sessions started in that repository.

## What it does

| Event | Module | Effect |
| --- | --- | --- |
| `tool_call` (`bash`, `ipython`) | `guard.ts` | Refuses a recursive grep of `~/.prime/agent`, a history rewrite in the sieun-pi checkout, an outside send without the owner's ok, and a PR merge without the owner's go on that PR. |
| `tool_call` (`ipython`) | `rlm-delete.ts` | In a subagent, makes `rlm.delete_subagent` wait until a child that already replied is idle. |

The extension adds no prompt text. The writing standard is the `unslop` skill, read on demand, and `config/AGENTS.md` (`~/.prime/agent/AGENTS.md`) points at it. Prime loads that file into the base system prompt, so owner turns, agent-message wakes, heartbeats and child notices all send the same prompt. Text added from a `before_agent_start` hook would break that: Prime 0.9.8 skips the hook on an agent-message wake, so the text vanishes on every wake and the prompt cache is rewritten twice. `components/user-history/test/prompt-prefix.test.ts` fails when any turn kind changes the cached prefix.

`rlm-delete.ts` works around a Prime 0.9.8 bug. A subagent that deletes its own child while the child is still in its turn fails with "RLM quiescence wait cancelled", and Prime then archives the subagent and cancels its other children. The parent's quiescence wait puts an abort controller on each child session, and the child's `requestAbort` and `dispose` abort every controller there, the parent's included. The usual trigger is a delete right after the child's report arrives, while the child still writes its last message. In a session at RLM depth 1 or more, the module adds one line to each ipython cell that calls `delete_subagent(`. That line patches `rlm.delete_subagent` to poll `rlm.list_subagents()` and wait, up to 90 s, until a child that already replied is idle. A child that has not replied is deleted at once, and the bug still fails the caller then. `GLOBAL_RULES_RLM_DELETE=off` turns it off. Delete the module once Prime stops aborting a parent's wait from a child's abort.

`grep-guard.ts` refuses `grep -r`, `-R`, `--recursive` and `-d recurse` when a target is `~/.prime/agent` or a folder above it. That folder holds many GB of sessions and artifacts. The refusal prints an `rg -n` command with the same pattern.

`sieun-pi.ts` applies to any git command whose target is a sieun-pi checkout: this source tree, or a clone whose origin is `sieu-n/sieun-pi`. It follows `cd`, `git -C`, `--git-dir` and `--work-tree`, so the session cwd does not matter.
It refuses a force push and `git reset --hard`. It allows `git rebase` and `git commit --amend` only while no remote branch holds a commit they rewrite.

`send-guard.ts` refuses an email or a vendor ticket reply unless the owner approved it on a For you todo (correction c37).
It covers mail CLIs (`mail -s`, `sendmail`, `msmtp`, `swaks`, `mutt`, `himalaya send`, Gmail and ticket CLIs, `osascript` to Mail), and `curl`, `wget`, `httpie` and `xh` writes to mail APIs, ticket APIs and `smtp://` URLs.
In an ipython cell it also covers `requests`, `httpx` and `urllib` writes to those hosts, `smtplib` and `yagmail` sends, the Gmail API client's `send`, MCP send or reply tools on mail and ticket servers, and raw `aside` MCP or CLI calls that press Send or ask the Aside agent to send.
Reading, drafting, a Gmail draft create, and GET requests stay allowed.
A call passes when it carries `OWNER_OK=<chat id>/<todo id>`, as an env prefix in bash or a `# OWNER_OK=...` line in a cell.
`components/user-history/src/owner-ok.ts` checks that token against `<data dir>/boards/<chat>.json`: the todo is checked off and the owner answered it with its first choice or another go.
The aside-browser skill holds the runtime check for Gmail and ticket pages in the browser, because it can read the tab's URL.

`merge-guard.ts` refuses a pull request merge, and a push or ref update that moves `main` or `master`, unless the owner said go on a For you todo that names that PR, or that repo and push (correction c49).
Staging lands never need the owner's ok (c50), so a push, ref update or branch merge into `staging` passes with no token. A `gh pr merge` names no base branch, so it stays refused even when the PR targets staging.
It covers `gh pr merge` with any flag (`--auto`, `--squash`, `--merge`, `--rebase`, `--admin`), a `gh api` or `curl` write to `repos/<o>/<r>/pulls/<n>/merge` or `repos/<o>/<r>/merges`, and the GitHub GraphQL mutations `enablePullRequestAutoMerge`, `mergePullRequest`, `enqueuePullRequest` and `mergeBranch`, sent by `gh api graphql`, `curl` or a Python HTTP call.
It covers `git push` in any repo whose target is one of those branches: `main`, `HEAD:main`, `+main`, `x:refs/heads/main`, `--delete main`, `:main`, `--all`, `--mirror`, and a bare `git push` or `git push origin HEAD` while the branch's push target is one of them.
It covers the refs API (`PATCH`, `DELETE` or `POST` on `repos/<o>/<r>/git/refs/heads/<branch>`, or `POST .../git/refs` with `ref=refs/heads/<branch>`) and the GraphQL mutations `updateRef`, `updateRefs`, `createCommitOnBranch` and `deleteRef`. A `POST .../merges` or GraphQL `mergeBranch` passes when its `base` is not `main` or `master`. A ref mutation that names no branch, such as `updateRef` by `refId`, is refused too.
It follows `cd`, `git -C`, `bash -c`, `$(...)`, `eval`, `env`, `sudo`, `timeout`, `xargs`, `ssh`, heredocs fed to a shell, and GraphQL bodies read from a file (`-F query=@q.graphql`, `--input body.json`, `-d @body.json`).
`gh pr merge --disable-auto`, reading PRs, a GET on `pulls/<n>/merge`, `git push --dry-run`, and pushes to any other branch stay allowed. auto-sns-agent's `git push origin sieun/dev` and the release train's `land.yml` and `promote.yml` dispatches stay with the repo's own release-owner guard (VP decision, 2026-10-12).
A merge or push passes with the same `OWNER_OK=<chat id>/<todo id>` token as a send. For a merge, the todo's text must name the PR: `#123`, `PR 123`, `pull request 123`, a `/pull/123` link, or the GraphQL node id for a mutation. For a push, it must name the repo, and the branch or the word push ("Push sieun-pi to the public repo?").
A merge that names no PR number, such as a bare `gh pr merge` or a branch name, is refused even with a token.

`cua-guard.ts` covers desktop sends through the `cua-driver` MCP server.
It runs as a stdio proxy in front of `cua-driver mcp`, so `~/.prime/agent/settings.json` starts the server as `node <repo>/components/global-rules/cua-guard.ts <cua-driver> mcp`.
The proxy remembers each `get_window_state` snapshot, so it knows the label behind an `element_token` and the element under a coordinate click.
It refuses a click, menu item or key press that sends from a mail app (Mail, Outlook, Spark and others), a chat app (Messages, Slack, KakaoTalk and others), or a window whose title names Gmail, a compose window or a ticket page.
The covered presses are a Send or Submit button, the `Message > Send` menu item, `Cmd+Shift+D`, `Cmd+Return`, and Return in a chat app.
A click by coordinates or by an unseen token in such an app is refused until a snapshot shows what it hits.
A call that names its window only through a nested `target: {kind: "window", pid, window_id}` is judged against that window.
A call aimed at the desktop (`scope: "desktop"` or `target: {kind: "desktop"}`) is judged against the frontmost window under its point, or the front window for a key press, which the proxy reads with `cua-driver call list_windows` just before it judges the call.
If the proxy cannot read the windows, it refuses a desktop click that lands on a Send label in any snapshot it has seen, and `Cmd+Return` or `Cmd+Shift+D` on the desktop.
A call passes with `owner_ok: "<chat id>/<todo id>"` in its arguments, which the proxy checks with `owner-ok.ts` and strips before it forwards the call.
`cua-driver call <tool> '<json>'` in a shell gets the same check from `guard.ts`.

## How it loads

```text
~/.prime/agent/extensions/global-rules.ts  (link to index.ts)
  -> guard.ts           -> grep-guard.ts, sieun-pi.ts, send-guard.ts, merge-guard.ts, cua-guard.ts -> shell.ts
                            send-guard.ts -> node --import tsx ../user-history/src/owner-ok.ts (send and merge approvals)
```

`index.ts` imports each feature in its own try/catch. A load-time throw in a global extension would stop every Prime session, and a broken guard must not take the other modules with it. A failed module is written to the log and shown once as a UI notice.
The modules are `.ts` files on purpose. Prime's loader re-reads nested `.ts` imports on each `/reload`, while it keeps nested `.mjs` imports cached for the life of the process.
After an edit, run `/reload` in an idle session. A new session loads the current source.

## Settings

| Variable | Effect |
| --- | --- |
| `GLOBAL_RULES=off` | Turns off the guard and the `rlm.delete_subagent` wait. |
| `GLOBAL_RULES_GUARD=off` | Turns off the guard. |
| `GLOBAL_RULES_RLM_DELETE=off` | Turns off the `rlm.delete_subagent` wait. |
| `GLOBAL_RULES_LOG=<path>` | Writes the log here instead of `$TMPDIR/global-rules.log`. |

The switches are read from the Prime process environment, so they must be set before the daemon or session starts.
Each log line names the rule and the session cwd, for example `[guard] block rule=grep cwd=/path :: grep -r foo ~/.prime`.

## Limits

The guard reads literal command text. It is not a sandbox.
It cannot see commands built from Python variables, helper scripts or a subprocess's later input, and it skips cells over 200,000 characters.
The kernel's `os.chdir` is invisible to it, so a bare git command is judged against the session cwd.
The send guard misses a send whose URL or command is built at runtime, a helper script that sends, a desktop send through an app it does not name, a cua-driver drag or typed Return that sends, and a desktop click on a panel or sheet above layer 0, because `list_windows` lists only layer-0 windows.
It also misses a desktop click on Send in a window that no snapshot has shown and that the guard cannot read, and a desktop click whose coordinates come from a downscaled `get_desktop_state` taken outside the proxy, such as a `cua-driver call` in a shell.
The merge guard misses a `gh` alias made before it saw the `gh alias set` call (`gh m 123` runs `pr merge` unseen), a merge or push whose command or URL is built at runtime, and a helper script that merges or pushes.
A handler error lets the call run and writes `handler error, failing open` to the log, because a bug here must not stop every tool call on the machine.

## Tests

```sh
node --test tests/global-rules-*.test.mjs
```

The suites feed command strings to the handlers and run none of them. `global-rules-native.test.mjs` loads the extension through Prime's own resource loader, reloads it after an edit, and checks that a broken guard leaves `rlm-delete.ts` in place. Every suite sets `GLOBAL_RULES_LOG` to a temporary file, so tests never write the live log.
