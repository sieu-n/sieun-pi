---
name: aside-browser
description: "The browser for this machine, with the user's logged-in sessions. Use for any web page task: open, read, click, fill, scrape, or screenshot sites and our own apps."
---

# aside-browser

This module drives the separately installed Aside browser through the `aside` MCP server and its `repl`, `exec` and `memory_search` tools.

## Setup

1. Install Aside and its CLI, and keep Aside.app running.
2. Check the signed-in account with `aside account status`, because a profile may not be signed in.
3. Add an `aside` stdio MCP server to the Prime Agent profile with `command: aside`, `args: [mcp]` and `callTimeoutMs: 130000`.
4. Put the CLI on the MCP process's `PATH`, or use its absolute path as the MCP command.
5. Start a new session or run `/reload`, because Prime Agent reads MCP settings only then.
6. Check access with `await aside_browser.tabs()`.

Without the MCP server, each call runs the one-shot CLI, and its output starts with `[aside-browser fallback]`.
The fallback keeps no state between calls, so multi-step tab work needs the MCP server.
The fallback looks for the CLI at `ASIDE_CLI`, then `aside` on `PATH`, then `~/.local/bin/aside`, so set `ASIDE_CLI` before the skill loads.

## Calls

```python
await aside_browser("return await page.title()")   # run REPL JS; `return value` prints it (`aside guide repl`)
await aside_browser.tabs()                       # [{targetId, active, title, url, owned}]
await aside_browser.open_tab(url)                # sets `page`; this session owns the tab
await aside_browser.attach(target_id=None)       # reuse a tab the user has open (None = active tab); not owned
await aside_browser.snapshot(interactive=True)   # a11y tree with [ref=eN]; then page.locator('eN').click()
await aside_browser.screenshot('/abs/path.png', full_page=False, annotated=False)  # copies the PNG out of the sandbox
await aside_browser.close_tab()                  # current tab, only if this session opened it
await aside_browser.close_tab(target_id)         # one owned tab; force=True closes any tab
await aside_browser.close_own_tabs()             # every tab this session opened
await aside_browser.owned_tabs()                 # open tabs this session opened
await aside_browser.agent("Find the unread Slack message from Alex")   # delegate to the Aside agent; returns session_id
await aside_browser.agent("continue", session_id="...")
await aside_browser.memory_search("what does the user work on")
```

`await aside_browser(code)` is `run(code, title="aside repl", wrap=True, force=False, owner_ok=None)`.

- Each call runs inside an async function, so the next call can reuse a `const` or `let` name.
- `page`, `tabs` and the other REPL globals persist between calls.
- To keep a value for a later call, set `globalThis.name = value`.
- `wrap=False` sends the code unchanged into the REPL's shared top-level scope.
- Each REPL call times out after 120 s, so hand a long multi-step task to `agent()`.

## Errors

Errors raise `AsideError`. For a known mistake, the message ends with an `[aside-browser hint]` line that names the fix.

- Page globals such as `document`, `window` and `location` do not exist in the REPL, so read them with `await page.evaluate(() => document.title)`.
- REPL helpers such as `sleep` and `page` do not exist inside `page.evaluate`, so wait there with `await new Promise(r => setTimeout(r, ms))`.

The Aside REPL lacks some Playwright methods:

| Missing | Use |
| --- | --- |
| `page.waitForTimeout(ms)` | `await sleep(ms)` |
| `page.setViewportSize()` | none, because the tab is the user's real window; read `page.viewportSize()` |
| `page.textContent(sel)`, `page.hover(sel)` and other page shortcuts | `page.locator(sel).textContent()` and so on |
| `locator.allInnerTexts()` | `locator.evaluateAll(els => els.map(e => e.innerText))` |
| `locator.getByRole()` | `page.getByRole(role, {name})` |
| `page.waitForFunction()` | poll `page.evaluate(...)` with `await sleep(200)` |
| `page.waitForNavigation()` | `page.waitForURL(...)` or `page.waitForLoadState()` |
| `page.context()` | none; use `openTab(url)` |

## Tab ownership

The user and other agents share the browser.
A tab belongs to the session that opened it with `open_tab()`, or with `openTab()` inside `run()`.
The module records owned tabs in `aside-browser-tabs.json` under `RLM_SESSION_DIR`, so the record survives a kernel restart.

- Use `attach()` only when the task is about a page the user already has open.
- Otherwise open your own tab with `open_tab()`, and call `close_own_tabs()` when done.
- `close_tab()` refuses a tab this session did not open, attached tabs included.
- `run()` refuses code that loops over `tabs` and closes them.
- Never call `page.close()`.
- Pass `force=True` only when the user asked for that tab to close.

## Site skills built into Aside

Gmail, Slack, Notion, Google Docs, Sheets and Search, YouTube, LinkedIn and iMessage have REPL globals (`gmail`, `slack`, `notion`, ...) that often work without a tab.
Before you drive one of these sites by hand, read its site skill:

```bash
aside skills list
aside skills show google-gmail
```

Then call the documented global inside `await aside_browser("...")`.
For a multi-step task on these sites, `agent()` usually costs less, because it has the same skills and the user's memory.

## Outside sends

An email, a vendor ticket reply, or a message or post to someone outside goes out only after the owner approves it on a For you todo (c37).
Reading mail and filling a reply or compose box stay allowed.

Every REPL call, `run()` and the private `_repl()` alike, passes a send check that refuses these actions:

| Page or call | Refused action |
| --- | --- |
| Webmail page such as Gmail | Send, or a send shortcut such as `Meta+Enter` |
| Support ticket page or contact form | submit, reply or Enter |
| X, LinkedIn, Discord, Facebook, Instagram, Reddit, WhatsApp web, Telegram web, a GitHub page outside `sieu-n` and `virev-ai` | post, send or Enter |
| Site skill send calls | `linkedin.sendMessage`, `imessage.send` and the like |
| Support chat widget such as Intercom | any click or typing |
| `agent()` | a task that asks the Aside agent to send or reply to an email, a ticket, or a message on those sites |

A click by coordinates, such as `page.mouse.click(x, y)`, is checked when it runs.
The check reads the element under the point and refuses Send on a webmail page, Send or Submit on a ticket or social page, and a click into a support chat widget's frame.

GitHub sign-in pages (`github.com/login`, `/login/oauth`, `/login/device` and `/sessions`) count as no post, so an agent finishes a GitHub sign-in there itself (c4).
Slack stays allowed, because both Slack workspaces are the owner's own.
Each send the check allows or refuses writes one line to the send log, which `board.sends()` reads.

To send:

1. Draft the message.
2. Add a For you todo with the draft, the recipient, and choices such as "Send it" / "Not yet".
3. After the owner approves the todo, pass `owner_ok="<chat id>/<todo id>"` to `run()` or `agent()`.

The check reads the chat's board through `components/user-history/src/owner-ok.ts` in the sieun-pi repo.
The todo must be checked off and answered by the owner with its first choice or another go.

## Browser rules

- Use no other browser automation, such as a CLI that launches its own browser, a headless browser, or a repo screenshot script.
- If a skill, playbook or memory names another browser tool, change that text to `aside-browser`.
- Screenshots are in device pixels, so read the viewport size and device pixel ratio before you crop for `attach_image`.
- Read pages with `snapshot()`, not `page.content()`.
- Pass a ref from the latest snapshot as `page.locator('e12')`, never inside a CSS selector, because each new snapshot invalidates the old refs.
- The REPL's `fs` reaches only the Aside session directory, while `screenshot()` writes to any local path that you then view with `attach_image`.
- `aside exec` sessions do not show in the chat list, so control them with `aside session list|resume|stop <id>`.

## Tests

From the sieun-pi repository root, `uv run python -m unittest discover -s skills/aside-browser/tests -v` runs the offline tests with a fake MCP server.
