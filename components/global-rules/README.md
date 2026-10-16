# global-rules

This Prime Agent extension holds the rules that apply to every session on this Mac, whatever the session's cwd is.
Repository rules do not live here. A repository ships its own guard as a project-local extension under `<repo>/.prime/agent/extensions/`, and Prime loads it only for sessions started in that repository.
auto-sns-agent is the one exception: its rules stay in that repo's `scripts/repo/agent/guards/`, and `auto-sns-agent.ts` loads them here for every session, because chat jobs start in `/Users/sieunpark` and still work in that checkout.

## What it does

| Event | Module | Effect |
| --- | --- | --- |
| `tool_call` (`bash`, `ipython`) | `guard.ts` | Refuses a recursive grep of `~/.prime/agent`, a history rewrite in the sieun-pi checkout, an outside send without the owner's ok, and a PR merge without the owner's go on that PR (off while the c74 standing go is on). |
| `tool_call` (`ipython`) | `kernel-guard.ts` | Installs `kernel-guard.py` in the Python kernel, which refuses an outside send at run time. |
| `tool_call` (`ipython`) | `rlm-delete.ts` | In a subagent, makes `rlm.delete_subagent` wait until a child that already replied is idle. |
| `session_start`, `tool_call` (`bash`, `ipython`) | `auto-sns-agent.ts` | Registers auto-sns-agent's repo guard (`scripts/repo/agent/guards/prime.mjs` in that checkout) for every session, and judges each git write a Python kernel starts with the kernel's real cwd. |

The extension adds no prompt text. The writing standard is the `unslop` skill, read on demand, and `config/AGENTS.md` (`~/.prime/agent/AGENTS.md`) points at it. Prime loads that file into the base system prompt, so owner turns, agent-message wakes, heartbeats and child notices all send the same prompt. Text added from a `before_agent_start` hook would break that: Prime 0.9.8 skips the hook on an agent-message wake, so the text vanishes on every wake and the prompt cache is rewritten twice. `components/user-history/test/prompt-prefix.test.ts` fails when any turn kind changes the cached prefix.

`rlm-delete.ts` works around a Prime 0.9.8 bug. A subagent that deletes its own child while the child is still in its turn fails with "RLM quiescence wait cancelled", and Prime then archives the subagent and cancels its other children. The parent's quiescence wait puts an abort controller on each child session, and the child's `requestAbort` and `dispose` abort every controller there, the parent's included. The usual trigger is a delete right after the child's report arrives, while the child still writes its last message. In a session at RLM depth 1 or more, the module adds one line to each ipython cell that calls `delete_subagent(`. That line patches `rlm.delete_subagent` to poll `rlm.list_subagents()` and wait, up to 90 s, until a child that already replied is idle. A child that has not replied is deleted at once, and the bug still fails the caller then. `GLOBAL_RULES_RLM_DELETE=off` turns it off. Delete the module once Prime stops aborting a parent's wait from a child's abort.

`grep-guard.ts` refuses `grep -r`, `-R`, `--recursive` and `-d recurse` when a target is `~/.prime/agent` or a folder above it. That folder holds many GB of sessions and artifacts. The refusal prints an `rg -n` command with the same pattern.

`sieun-pi.ts` applies to any git command whose target is a sieun-pi checkout: this source tree, or a clone whose origin is `sieu-n/sieun-pi`. It follows `cd`, `git -C`, `--git-dir` and `--work-tree`, so the session cwd does not matter.
It refuses a force push and `git reset --hard`. It allows `git rebase` and `git commit --amend` only while no remote branch holds a commit they rewrite.

`send-guard.ts` refuses an outside send unless the owner approved it on a For you todo (correction c37): an email, a vendor ticket reply, a message to someone outside, or a post on a repo or site the owner does not own.
`send-targets.json` lists the HTTP endpoints that send: mail APIs, ticket APIs and portals, Discord, Telegram, Twilio, WhatsApp, Teams, LinkedIn and X, Stripe invoice sends, Clerk invitations, any non-local `.../email/send` route, and GitHub issue, comment and review writes on repos outside `sieu-n` and `virev-ai`.
In bash it covers mail CLIs (`mail -s`, `sendmail`, `msmtp`, `swaks`, `mutt`, `himalaya send`, Gmail and ticket CLIs), `osascript` sends from Mail or Messages (inline, JXA or a script file), and `curl`, `wget`, `httpie` and `xh` writes to those endpoints.
It also covers `gh issue` and `gh pr` writes and `gh api` writes on repos the owner does not own, `stripe invoices send`, `vercel teams invite`, `convex run` of a function whose name sends (`sendEmail`, `emailSend`, `notifyEmail`), and a `cua-driver mcp` started outside the proxy.
It reads the code that a runner starts: `python -c`, `node -e`, `uv run`, `npx`, and a Python, JavaScript, shell or AppleScript file named on the command line.
It follows `eval` and shell variables set earlier in the same command, such as `URL=...; curl "$URL"`.
In an ipython cell it also covers `requests`, `httpx` and `urllib` writes to those endpoints, `smtplib` and `yagmail` sends, mail SDK sends (Resend, SendGrid, Postmark), Twilio messages, the Gmail API client's `send`, MCP send or reply tools on mail and ticket servers, and raw `aside` MCP or CLI calls that press Send or ask the Aside agent to send.
Slack stays allowed everywhere except the desktop app: both Slack workspaces are the owner's own, and the slack-green lab posts in the test workspace every day.
Reading, drafting, a Gmail draft create, and GET requests stay allowed.
A call passes when it carries `OWNER_OK=<chat id>/<todo id>`, as an env prefix in bash or a `# OWNER_OK=...` line in a cell.
`components/user-history/src/owner-ok.ts` checks that token against `<data dir>/boards/<chat>.json`: the todo is checked off and the owner answered it with its first choice or another go.
The aside-browser skill holds the runtime check for webmail, ticket, contact and social pages in the browser, because it can read the tab's URL.

`kernel-guard.ts` adds the run-time half of the send guard to the Python kernel.
It prepends one line to each ipython cell, and that line runs `kernel-guard.py` once per kernel.
From then on the kernel checks each send as it happens, so a command, URL or MCP tool built at run time is judged like a literal one.
It checks every subprocess (`bash()`, `subprocess`, `os.system`) whose text names a send tool, with shell variables from the process environment filled in, through `send-check.ts`, which runs the tool_call guard's own rules.
It checks HTTP writes from `httpx` and `httpx2`, and every HTTP/1 request written to a socket, against `send-targets.json` in Python.
The socket check covers `requests`, `urllib`, `http.client`, raw `socket` and `ssl` writes, and asyncio TLS such as `aiohttp`, whose request it reads at `ssl.SSLObject.write` before encryption.
It also checks connects to SMTP ports 25, 465, 587 and 2525 on any non-local host, and every `rlm.mcp.call_tool` call that may send.
It puts `python-child/` first on `PYTHONPATH`, so a Python process the kernel starts, such as a helper script or a `uv run` command, installs the same guard through `sitecustomize.py` and then runs the next `sitecustomize` on its path.
A refused call raises `SendRefused` with the same text as the tool_call guard.
A call passes when a cell on the stack carries an approved `OWNER_OK=<chat id>/<todo id>`, or, in a child process, when `OWNER_OK` is in its environment.
Calls made inside the aside_browser skill are left to that skill's page check.

`send-log.ts` keeps the record of outside sends (c37), so "did an agent send anything" has one answer.
Each layer above writes one JSON line per send it judges to `~/.prime/agent/browser-chat/sends.jsonl`: the tool_call guard, `send-check.ts` for the kernel, the cua-driver proxy and the aside-browser skill.
A line holds the time, the decision (`allowed` or `refused`), the layer, the chat and session, the target, the guard's reason and the OWNER_OK token.
The tool_call guard logs an allowed ipython cell only when it runs, through the kernel check, so one send makes one allowed line.
`components/user-history/src/send-log.ts backfill` adds the sends that older transcripts show as `ran` lines, up to the first live line, and the same file reads the log (`--match`, `--since`, `--chat`). Chats read it with `board.sends(...)`.
`GLOBAL_RULES_SEND_LOG` moves the file; without it, `AGENT_CHAT_DATA_DIR` or the folder of `GLOBAL_RULES_LOG` does, so a suite that moves the guard log moves this one too.

`merge-guard.ts` refuses a pull request merge, and a push or ref update that moves `main` or `master`, unless the owner said go on a For you todo that names that PR, or that repo and push (correction c49).
Until the proper launch the owner pre-approves every prod promote, merge or push to main (correction c74, 2026-10-15), so while `releaseGo.preapproval` in `components/user-history/src/shared/release-go.ts` is set, `merge-guard.ts` passes every merge and push with no token. Setting it to null brings back every refusal below. The send guard does not read it.
Staging lands never need the owner's ok (c50), so a push, ref update or branch merge into `staging` passes with no token. A `gh pr merge` names no base branch, so it stays refused even when the PR targets staging.
It covers `gh pr merge` with any flag (`--auto`, `--squash`, `--merge`, `--rebase`, `--admin`), a `gh api` or `curl` write to `repos/<o>/<r>/pulls/<n>/merge` or `repos/<o>/<r>/merges`, and the GitHub GraphQL mutations `enablePullRequestAutoMerge`, `mergePullRequest`, `enqueuePullRequest` and `mergeBranch`, sent by `gh api graphql`, `curl` or a Python HTTP call.
It covers `git push` in any repo whose target is one of those branches: `main`, `HEAD:main`, `+main`, `x:refs/heads/main`, `--delete main`, `:main`, `--all`, `--mirror`, and a bare `git push` or `git push origin HEAD` while the branch's push target is one of them.
It covers the refs API (`PATCH`, `DELETE` or `POST` on `repos/<o>/<r>/git/refs/heads/<branch>`, or `POST .../git/refs` with `ref=refs/heads/<branch>`) and the GraphQL mutations `updateRef`, `updateRefs`, `createCommitOnBranch` and `deleteRef`. A `POST .../merges` or GraphQL `mergeBranch` passes when its `base` is not `main` or `master`. A ref mutation that names no branch, such as `updateRef` by `refId`, is refused too.
It follows `cd`, `git -C`, `bash -c`, `$(...)`, `eval`, `env`, `sudo`, `timeout`, `xargs`, `ssh`, heredocs fed to a shell, and GraphQL bodies read from a file (`-F query=@q.graphql`, `--input body.json`, `-d @body.json`).
`gh pr merge --disable-auto`, reading PRs, a GET on `pulls/<n>/merge`, `git push --dry-run`, and pushes to any other branch stay allowed. auto-sns-agent's `git push origin sieun/dev` and the release train's `land.yml` and `promote.yml` dispatches stay with the repo's own release-owner guard (VP decision, 2026-10-12), which `auto-sns-agent.ts` loads.
A merge or push passes with the same `OWNER_OK=<chat id>/<todo id>` token as a send. For a merge, the todo's text must name the PR: `#123`, `PR 123`, `pull request 123`, a `/pull/123` link, or the GraphQL node id for a mutation. For a push, it must name the repo, and the branch or the word push ("Push sieun-pi to the public repo?").
A merge that names no PR number, such as a bare `gh pr merge` or a branch name, is refused even with a token.

It follows `bash -c`, `$(...)`, `eval`, `timeout`, `xargs`, `ssh`, heredocs fed to a shell, the `perl -e 'alarm 60; exec @ARGV'` time limit wrapper, and a prefix filled in at run time such as `{T60} gh run cancel <id>`.
In the kernel, `kernel-guard.py` sends each `gh` subprocess and each Python POST or DELETE to those paths through `send-check.ts`, which judges by the kernel's `RLM_SESSION_DIR`, so a command or URL built at run time is refused too, with `SendRefused` and the same text.
`gh run view`, `gh run watch`, `gh run list` and every GET stay allowed for everyone. No OWNER_OK token lifts this rule.

`auto-sns-agent.ts` loads auto-sns-agent's repo guard for every session, whatever its cwd. The rules and their tests stay in that repo's `scripts/repo/agent/guards/`, and its Claude Code hook calls the same rules.
On 2026-10-14 at 14:40Z a Crawler ops job started in `/Users/sieunpark` ran `bash("git push origin 7ac6657831...:refs/heads/sieun/dev")` after `os.chdir` into the checkout. The repo guard then loaded only for sessions started in the checkout, so nothing judged the push.
The tool_call half registers the repo's `prime.mjs`, whose rules follow `cd`, `git -C` and, for a push, the remote's URL. So a push of `sieun/dev` or `main` from a session started anywhere, from another clone, or to the repo's URL is refused unless the release owner (`01a10810`) makes it.
A kernel's `os.chdir` is invisible to that text, so `kernel-guard.py` also sends each git write a kernel starts to `send-check.ts` with the kernel's real cwd, when the cwd or text names `auto-sns-agent` or the command pushes. `send-check.ts` runs the repo's `onToolCall` with the session id read from `RLM_SESSION_DIR`, which is the session id only for a root session, so a subagent is never the release owner. A refusal raises `SendRefused` with the repo guard's text, and each verdict is a line in the repo's `.cache/repo-guard/log.jsonl`.
If the repo's rules fail to load, a call that looks like a git write, a deploy or a local check is refused in a session started in the checkout, or when its text names `auto-sns-agent`, and the failure is logged. With no checkout at `~/Documents/Github/auto-sns-agent` (`GLOBAL_RULES_AUTO_SNS_AGENT` moves it) the module does nothing.

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
                            send-guard.ts -> send-targets.json, node --import tsx ../user-history/src/owner-ok.ts (send and merge approvals)
  -> kernel-guard.ts    -> ipython cell prelude -> kernel-guard.py -> send-targets.json, node send-check.ts -> guard.ts, auto-sns-agent.ts
                            python-child/sitecustomize.py -> kernel-guard.py (Python processes the kernel starts)
  -> auto-sns-agent.ts  -> ~/Documents/Github/auto-sns-agent/scripts/repo/agent/guards/prime.mjs (that repo's rules)
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
| `GLOBAL_RULES_AUTO_SNS_AGENT=<path>` | Loads auto-sns-agent's repo guard from this checkout instead of `~/Documents/Github/auto-sns-agent`. |

The switches are read from the Prime process environment, so they must be set before the daemon or session starts.
Each log line names the rule and the session cwd, for example `[guard] block rule=grep cwd=/path :: grep -r foo ~/.prime`.

## Limits

The tool_call guard reads literal command text. The kernel guard checks the calls a Python process makes at run time. Neither is a sandbox.
The tool_call guard skips cells over 200,000 characters.
The kernel's `os.chdir` is invisible to the tool_call guard, so a bare git command is judged against the session cwd. The kernel guard covers that gap for auto-sns-agent's git rules only.
The send guard misses a command decoded at run time and piped to a shell (`base64 -d | sh`), a Node process that sends from a module the script imports, an HTTP request whose request line is split over several socket writes, HTTP/2, the private `rlm.mcp._registry`, a body-only WHMCS ticket call sent through `http.client`, a desktop send through an app it does not name, a cua-driver drag, `System Events` keystrokes, and a desktop click on a panel or sheet above layer 0, because `list_windows` lists only layer-0 windows.
It also misses a desktop click on Send in a window that no snapshot has shown and that the guard cannot read, and a desktop click whose coordinates come from a downscaled `get_desktop_state` taken outside the proxy, such as a `cua-driver call` in a shell.
In the Aside browser it misses Tab then Enter on a webmail page, selectors built at run time (`atob`), Gmail inside another site's iframe, and a mouse call through another name (`const m = page.mouse; m.click(x, y)`).
The merge guard misses a `gh` alias made before it saw the `gh alias set` call (`gh m 123` runs `pr merge` unseen), a merge or push whose command or URL is built at runtime, and a helper script that merges or pushes.
A handler error lets the call run and writes `handler error, failing open` to the log, because a bug here must not stop every tool call on the machine. The kernel guard also lets a call run when Node or `send-check.ts` cannot run.

## Tests

```sh
node --test tests/global-rules-*.test.mjs
uv run --locked --no-sync python -B -m unittest discover -s tests -p "test_kernel_*.py"
```

`global-rules-auto-sns-agent.test.mjs` and `test_kernel_repo_guard.py` copy the live checkout's `scripts/repo/agent/guards` into a fixture checkout, so they test the rules agents get, and they skip on a machine without that checkout. The kernel test runs a fake `git`, so nothing reaches GitHub.

The Node suites feed command strings to the handlers and run none of them. `test_kernel_send_guard.py` runs `kernel-guard.py` in fresh Python processes against a fake `curl`, a local HTTP server, `httpx.MockTransport` and a fake `rlm.mcp`, so nothing leaves the machine. `global-rules-native.test.mjs` loads the extension through Prime's own resource loader, reloads it after an edit, and checks that a broken guard leaves `rlm-delete.ts` in place. Every suite sets `GLOBAL_RULES_LOG` to a temporary file, so tests never write the live log.
