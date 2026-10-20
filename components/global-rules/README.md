# global-rules

This Prime Agent extension holds the rules that apply to every session on this Mac, whatever the session's cwd is.
Repository rules do not live here. A repository ships its own guard as a project-local extension under `<repo>/.prime/agent/extensions/`, and Prime loads it only for sessions started in that repository.
auto-sns-agent is the one exception: its rules stay in that repo's `scripts/repo/agent/guards/`, and `auto-sns-agent.ts` loads them here for every session, because chat jobs start in `/Users/sieunpark` and still work in that checkout.

## What it does

| Event | Module | Effect |
| --- | --- | --- |
| `tool_call` (`bash`, `ipython`) | `guard.ts` | Refuses a history rewrite in the sieun-pi checkout, and an outside send without the owner's ok. |
| `tool_call` (`ipython`) | `kernel-guard.ts` | Installs `kernel-guard.py` in the Python kernel, which refuses an outside send at run time. |
| `tool_call` (`ipython`) | `rlm-delete.ts` | In a subagent, makes `rlm.delete_subagent` wait until a child that already replied is idle. |
| `tool_call` (`ipython`) | `kernel-guard.ts` | Also installs `kernel-own.py`, which records each path under `~/scratch` the kernel makes, on this box or on another one over ssh, in the session's `owned.json`, and refuses a recursive delete below `~/scratch` of a tree the job did not make (c130). |
| `tool_call` (`ipython`) | `kernel-guard.ts` | Also installs `kernel-read.py`, which refuses reads of another family's session transcripts in the kernel and the Python processes it starts. |
| `tool_call` (`read`, `grep`, `bash`) | `transcript-guard.ts` | Refuses the same transcript reads through the tools, with `kernel-read.py --judge`. |
| `session_start`, `tool_call` (`bash`, `ipython`) | `auto-sns-agent.ts` | Registers auto-sns-agent's repo guard (`scripts/repo/agent/guards/prime.mjs` in that checkout) for every session, and judges each git write a Python kernel starts with the kernel's real cwd. |

The extension adds no prompt text. The writing standard is the `unslop` skill, read on demand, and `config/AGENTS.md` (`~/.prime/agent/AGENTS.md`) points at it. Prime loads that file into the base system prompt, so owner turns, agent-message wakes, heartbeats and child notices all send the same prompt. Text added from a `before_agent_start` hook would break that: Prime 0.9.8 skips the hook on an agent-message wake, so the text vanishes on every wake and the prompt cache is rewritten twice. `components/user-history/test/prompt-prefix.test.ts` fails when any turn kind changes the cached prefix.

`rlm-delete.ts` works around a Prime 0.9.8 bug. A subagent that deletes its own child while the child is still in its turn fails with "RLM quiescence wait cancelled", and Prime then archives the subagent and cancels its other children. The parent's quiescence wait puts an abort controller on each child session, and the child's `requestAbort` and `dispose` abort every controller there, the parent's included. The usual trigger is a delete right after the child's report arrives, while the child still writes its last message. In a session at RLM depth 1 or more, the module adds one line to each ipython cell that calls `delete_subagent(`. That line patches `rlm.delete_subagent` to poll `rlm.list_subagents()` and wait, up to 90 s, until a child that already replied is idle. A child that has not replied is deleted at once, and the bug still fails the caller then. `GLOBAL_RULES_RLM_DELETE=off` turns it off. Delete the module once Prime stops aborting a parent's wait from a child's abort.

`sieun-pi.ts` applies to any git command whose target is a sieun-pi checkout: this source tree, or a clone whose origin is `sieu-n/sieun-pi`. It follows `cd`, `git -C`, `--git-dir` and `--work-tree`, so the session cwd does not matter.
It refuses a force push and `git reset --hard`. It allows `git rebase` and `git commit --amend` only while no remote branch holds a commit they rewrite.

`send-guard.ts` refuses an outside send unless the owner approved it on a For you todo (correction c37): an email, a vendor ticket reply, a message to someone outside, or a post on a repo or site the owner does not own.
`send-targets.json` lists the HTTP endpoints that send: mail APIs, ticket APIs and portals, Discord, Telegram, Twilio, WhatsApp, Teams, LinkedIn and X, Stripe invoice sends, Clerk invitations, any non-local `.../email/send` route, and GitHub issue, comment and review writes on repos outside `sieu-n` and `virev-ai`.
In bash it covers mail CLIs (`mail -s`, `sendmail`, `msmtp`, `swaks`, `mutt`, `himalaya send`, Gmail and ticket CLIs), `osascript` sends from Mail or Messages (inline, JXA or a script file), and `curl`, `wget`, `httpie` and `xh` writes to those endpoints.
It also covers `gh issue` and `gh pr` writes and `gh api` writes on repos the owner does not own, `stripe invoices send`, `vercel teams invite`, `convex run` of a function whose name sends (`sendEmail`, `emailSend`, `notifyEmail`), and a `cua-driver mcp` started outside the proxy.
A `convex run` passes when its deployment is this machine's own Convex on a loopback URL and that deployment's `VENT_URL` answers `"mode": "mock"` on `/healthz`, since a mock-mode Vent answers every provider call from its fakes, and only while that deployment holds no SMTP sender, since an SMTP send goes from Convex straight to the sender's server.
It reads the code that a runner starts: `python -c`, `node -e`, `uv run`, `npx`, and a Python, JavaScript, shell or AppleScript file named on the command line.
It follows `eval` and shell variables set earlier in the same command, such as `URL=...; curl "$URL"`.
In an ipython cell it also covers `requests`, `httpx` and `urllib` writes to those endpoints, `smtplib` and `yagmail` sends, mail SDK sends (Resend, SendGrid, Postmark), Twilio messages, the Gmail API client's `send`, MCP send or reply tools on mail and ticket servers, and raw `aside` MCP or CLI calls that press Send or ask the Aside agent to send.
Slack stays allowed everywhere except the desktop app: both Slack workspaces are the owner's own, and the slack-green lab posts in the test workspace every day.
Reading, drafting, a Gmail draft create, and GET requests stay allowed.
A call passes when it carries `OWNER_OK=<chat id>/<todo id>`, as an env prefix in bash or a `# OWNER_OK=...` line in a cell.
`components/user-history/src/owner-ok.ts` checks that token against the chat's live board: the todo is checked off and the owner answered it with its first choice or another go. On a box where hosts.json puts the chat role on another box, it reads the board from that chat service (`api/agent/board`), as the board skill does. It reads `<data dir>/boards/<chat>.json` on the chat host, or when the chat host cannot be reached, and the refusal and its stderr line name the board it read.
The aside-browser skill holds the runtime check for webmail, ticket, contact and social pages in the browser, because it can read the tab's URL.

`kernel-guard.ts` adds the run-time half of the send guard to the Python kernel.
It prepends one line to each ipython cell, and that line runs `kernel-guard.py` once per kernel.
The same line runs `kernel-cwd.py` once per kernel. It writes the kernel's pid, host and cwd to `$RLM_SESSION_DIR/kernel-cwd.json` at load and after each `os.chdir`.
Both tool_call guards judge an ipython cell where it runs, which `kernel-cwd.ts` works out. The cell starts in the cwd that report names while its kernel lives, else in `ctx.cwd`, which Prime sets to the session's start cwd. Each `os.chdir` the cell spells out, such as a string, an f-string, a name the cell set, `Path(...) / 'x'` or `os.path.expanduser(...)`, moves the cwd for the commands after it. A bash call follows its own `cd` and `git -C`, as before.
On 10-19 a replay of the box's last 24 h found git commits in prime-agent, sieun-pi and scratch repos judged as if they ran in auto-sns-agent's checkout, because their sessions had started there.
From then on the kernel checks each send as it happens, so a command, URL or MCP tool built at run time is judged like a literal one.
It checks every subprocess (`bash()`, `subprocess`, `os.system`) whose text names a send tool, with shell variables from the process environment filled in, through `send-check.ts`, which runs the tool_call guard's own rules.
Every Python process on the box with the same global-rules files and environment shares one `node send-check.ts --serve-socket <path>`, started by the first check that finds none. The socket's name hashes the `.ts` and `.json` files and the environment without the per-session `RLM_*`, `PRIME_AGENT_INTERNAL_*` and `PRIME_AGENT_KERNEL_*` keys. Each check carries its process's whole environment and cwd, which the judge takes on before it judges, so the verdict is the one a fresh `node send-check.ts` in that process would give. The judge exits after 2 minutes with no check, and a check that cannot reach or start one runs `node send-check.ts` once. A git argv list with no shell syntax in any word skips the check, because no send rule judges git.
It checks HTTP writes from `httpx` and `httpx2` where the network transport takes them, so a client on a mock transport, such as a mock-mode Vent, is not judged, and it checks every HTTP/1 request written to a socket, all against `send-targets.json` in Python.
The socket check covers `requests`, `urllib`, `http.client`, raw `socket` and `ssl` writes, and asyncio TLS such as `aiohttp`, whose request it reads at `ssl.SSLObject.write` before encryption.
It also checks connects to SMTP ports 25, 465, 587 and 2525 on any non-local host, and every `rlm.mcp.call_tool` call that may send.
It puts `python-child/` first on `PYTHONPATH`, so a Python process the kernel starts, such as a helper script or a `uv run` command, installs the same guard through `sitecustomize.py` and then runs the next `sitecustomize` on its path.
A refused call raises `SendRefused` with the same text as the tool_call guard.
A call passes when a cell on the stack carries an approved `OWNER_OK=<chat id>/<todo id>`, or, in a child process, when `OWNER_OK` is in its environment.
A Starlette or FastAPI server in such a process, such as a Vent started from a kernel, also takes the token from the `x-owner-ok: <chat id>/<todo id>` header of the request it is answering, and refuses its sends for any request without an approved one.
Calls made inside the aside_browser skill are left to that skill's page check.

`kernel-read.py` keeps each session to its own family's transcripts.
On 10-19 the runtime intent trace job and on 10-20 from 15:59Z to 16:10Z p8-prepare-hold, both jobs of chat-057a, opened the transcripts of unrelated roots under `~/.prime/agent/sessions` to read their state lines, and the scope reminder in each brief came too late. agent_observe already limits observation to the parent, siblings and children, but a cell could still open the files.
A session's family is itself, the sessions above it up to its root, its siblings and every session below it. Every other `<session id>.jsonl` under the Prime agent dir is refused, including copies under `backups/` and `moved-back-to-mac/`, and only `clean-room/` is left out, since a clean-room run reads its own test chats there.
The kernel refuses `open()`, `io.open()`, `os.open()` and `Path.read_text()` of such a file from cell code or from any code that is not a tool, and a command it starts that names such a file or reads a folder holding one as a whole (`rg`, `grep -r`, `find ... -exec` or `| xargs` a reader, `cp -r`, `rsync`, `tar`).
A refused call raises `TranscriptRefused`, a `PermissionError`, whose text names the session's own transcripts and the paths that stay open: agent_observe, `prime-agent status`, the board, job-resumes and duty files, the daemon-workers descriptors and logs, and a relay from the chat that owns the session.
Code in this sieun-pi tree, the chat release, the runtime copy, a skill folder or the Prime release passes, and so does the kernel's `rlm` package for a file read, so the board module, agent_observe, `resume_paused.py` and the d7, d9 and d10 prechecks read what they read before. Listing (`ls`, `find`, `os.listdir`) and counting lines (`wc`) pass, since they show catalog metadata and no content.
Each refusal is one JSON line in `~/.prime/agent/logs/transcript-refusals.jsonl` (`GLOBAL_RULES_TRANSCRIPT_LOG` moves it), with the session folder, the path and the session it belongs to, so the d10 audit can count repeats.
With no `RLM_SESSION_DIR` below `session-artifacts` (CI, a person's shell) nothing is judged.

`send-log.ts` keeps the record of outside sends (c37), so "did an agent send anything" has one answer.
Each layer above writes one JSON line per send it judges to `~/.prime/agent/browser-chat/sends.jsonl`: the tool_call guard, `send-check.ts` for the kernel, the cua-driver proxy and the aside-browser skill.
A line holds the time, the decision (`allowed` or `refused`), the layer, the chat and session, the target, the guard's reason and the OWNER_OK token.
The tool_call guard logs an allowed ipython cell only when it runs, through the kernel check, so one send makes one allowed line.
A backfill on 10-13 added the sends that older transcripts show as `ran` lines, up to the first live line. Chats read the log with `board.sends(...)`.
`GLOBAL_RULES_SEND_LOG` moves the file; without it, `AGENT_CHAT_DATA_DIR` or the folder of `GLOBAL_RULES_LOG` does, so a suite that moves the guard log moves this one too.

`auto-sns-agent.ts` loads auto-sns-agent's repo guard for every session, whatever its cwd. The rules and their tests stay in that repo's `scripts/repo/agent/guards/`, and its Claude Code hook calls the same rules.
On 2026-10-14 at 14:40Z a Crawler ops job started in `/Users/sieunpark` ran `bash("git push origin 7ac6657831...:refs/heads/sieun/dev")` after `os.chdir` into the checkout. The repo guard then loaded only for sessions started in the checkout, so nothing judged the push.
The tool_call half registers the repo's `prime.mjs`, whose rules follow `cd`, `git -C` and, for a push, the remote's URL. So a push of `sieun/dev` or `main` from a session started anywhere, from another clone, or to the repo's URL is refused unless the release owner (`01a10810`) makes it.
A kernel's `os.chdir` is invisible to that text, so `kernel-guard.py` also sends each git write a kernel starts to `send-check.ts` with the kernel's real cwd, when the cwd or text names `auto-sns-agent` or the command pushes. `send-check.ts` runs the repo's `onToolCall` with the session id read from `RLM_SESSION_DIR`, which is the session id only for a root session, so a subagent is never the release owner. A refusal raises `SendRefused` with the repo guard's text, and each verdict is a line in the repo's `.cache/repo-guard/log.jsonl`.
The guard that runs is the one the checkout's HEAD holds, never the working tree, so a session's unsaved edit changes nothing for other sessions. Each call reads HEAD's commit id from `.git`, and when a new commit changes the guard tree, `auto-sns-agent.ts` copies that tree's blobs to `.cache/repo-guard/<tree id>/guards/` and imports the copy, so a live session follows a landed guard change at its next tool call with no restart. A kernel check also loads the guard from HEAD, and so does each `node send-check.ts` run. If the repo's rules fail to load, the failure goes to the log and nothing is refused in their place. A landed version that fails to load keeps the last one that loaded. With no checkout at `~/Documents/Github/auto-sns-agent` (`GLOBAL_RULES_AUTO_SNS_AGENT` moves it) the module does nothing.

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
  -> guard.ts           -> sieun-pi.ts, send-guard.ts, cua-guard.ts -> shell.ts
                            send-guard.ts -> send-targets.json, node --import tsx ../user-history/src/owner-ok.ts (send approvals)
  -> kernel-guard.ts    -> ipython cell prelude -> kernel-guard.py -> send-targets.json, node send-check.ts -> guard.ts, auto-sns-agent.ts
                            ipython cell prelude -> kernel-read.py (transcript reads), also through python-child/sitecustomize.py
                            ipython cell prelude -> kernel-cwd.py -> $RLM_SESSION_DIR/kernel-cwd.json -> kernel-cwd.ts (guard.ts, auto-sns-agent.ts)
                            python-child/sitecustomize.py -> kernel-guard.py (Python processes the kernel starts)
  -> transcript-guard.ts -> python3 kernel-read.py --judge (read, grep and bash tools)
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
Each log line names the rule and the session cwd, for example `[guard] block rule=sieun-pi cwd=/path :: git reset --hard`.

## Limits

The tool_call guard reads literal command text. The kernel guard checks the calls a Python process makes at run time. Neither is a sandbox.
The tool_call guard skips cells over 200,000 characters.
A chdir to a name an earlier cell set is invisible to the cell text, so the tool_call guard judges the commands after it from the cell's start cwd until the kernel reports its new cwd. The kernel guard covers that gap for auto-sns-agent's git rules only.
The send guard misses a command decoded at run time and piped to a shell (`base64 -d | sh`), a Node process that sends from a module the script imports, an HTTP request whose request line is split over several socket writes, HTTP/2, the private `rlm.mcp._registry`, a body-only WHMCS ticket call sent through `http.client`, a desktop send through an app it does not name, a cua-driver drag, `System Events` keystrokes, and a desktop click on a panel or sheet above layer 0, because `list_windows` lists only layer-0 windows.
It also misses a desktop click on Send in a window that no snapshot has shown and that the guard cannot read, and a desktop click whose coordinates come from a downscaled `get_desktop_state` taken outside the proxy, such as a `cua-driver call` in a shell.
In the Aside browser it misses Tab then Enter on a webmail page, selectors built at run time (`atob`), Gmail inside another site's iframe, and a mouse call through another name (`const m = page.mouse; m.click(x, y)`).
The transcript guard misses a shell variable set earlier in the same command (`F=...; cat "$F"`), a Node process that reads a transcript, `rg --hidden` or `grep -r` over the whole home folder, a script that a job puts inside a tool folder itself, and a read through a file descriptor it did not open by name.
A handler error lets the call run and writes `handler error, failing open` to the log, because a bug here must not stop every tool call on the machine. The kernel guard also lets a call run when Node or `send-check.ts` cannot run.

## Tests

```sh
node --test tests/global-rules-*.test.mjs
uv run --locked --no-sync python -B -m unittest discover -s tests -p "test_kernel_*.py"
```

`global-rules-auto-sns-agent.test.mjs`, `global-rules-kernel-push-target.test.mjs` and `test_kernel_repo_guard.py` copy the live checkout's `scripts/repo/agent/guards` into a fixture checkout and commit them there, so they test the rules agents get, and they skip on a machine without that checkout. The kernel test runs a fake `git`, so nothing reaches GitHub.

The Node suites feed command strings to the handlers and run none of them. `test_kernel_send_guard.py` runs `kernel-guard.py` in fresh Python processes against a fake `curl`, a local HTTP server, an `httpx` network transport over a fake connection pool and a fake `rlm.mcp`, so nothing leaves the machine. `global-rules-native.test.mjs` loads the extension through Prime's own resource loader, reloads it after an edit, and checks that a broken guard leaves `rlm-delete.ts` in place. `global-rules-kernel-read.test.mjs` builds two families of fake transcripts under a temporary HOME and runs the prelude in fresh Python processes, so a refused read never touches a live transcript. Every suite sets `GLOBAL_RULES_LOG` to a temporary file, so tests never write the live log.
