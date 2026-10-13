---
name: aside-browser
description: "The browser for this machine, with the user's logged-in sessions. Use for any web page task: open, read, click, fill, scrape, or screenshot sites and our own apps."
---

# aside-browser

This skill drives a separately installed Aside browser through the `aside` MCP server and its `repl`, `exec` and `memory_search` tools.
It does not install Aside, sign in to accounts, or configure MCP.

## Setup

- Install Aside and its CLI, and keep Aside.app running.
- Check the signed-in account with `aside account status`. Do not assume a profile is signed in.
- Add an `aside` stdio MCP server to the Prime Agent profile with `command: aside`, `args: [mcp]` and `callTimeoutMs: 130000`.
- Put the CLI on the MCP process's `PATH`, or use its absolute path as the MCP command.
- Prime Agent reads MCP settings at session start or `/reload`.
- Without the MCP server, each call runs the one-shot CLI, and its output starts with `[aside-browser fallback]`.
- The CLI fallback keeps no state between calls, so multi-step tab work needs the MCP server.
- The fallback finds the CLI at `ASIDE_CLI`, then `aside` on `PATH`, then `~/.local/bin/aside`. Set `ASIDE_CLI` before the skill loads.
- Check access with `await aside_browser.tabs()`.

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

`await aside_browser(code)` is `run(code, title="aside repl", wrap=True, force=False)`.

- Each call runs inside an async function, so `const` and `let` names can be reused in the next call.
- `page`, `tabs`, and other REPL globals persist between calls.
- Keep a value for a later call with `globalThis.name = value`.
- `wrap=False` sends the code unchanged into the REPL's shared top-level scope.
- Each call has 120 s. Hand long multi-step tasks to `agent()`.

## Errors

Errors raise `AsideError`. For known mistakes, the message ends with an `[aside-browser hint]` line that names the fix.

- Page globals such as `document`, `window` and `location` do not exist in the REPL. Use `await page.evaluate(() => document.title)`.
- REPL helpers such as `sleep` and `page` do not exist inside `page.evaluate`. Wait there with `await new Promise(r => setTimeout(r, ms))`.
- Some Playwright methods are missing:

| Missing | Use |
| --- | --- |
| `page.waitForTimeout(ms)` | `await sleep(ms)` |
| `page.setViewportSize()` | none; read `page.viewportSize()` |
| `page.textContent(sel)`, `page.hover(sel)` and other page shortcuts | `page.locator(sel).textContent()` and so on |
| `locator.allInnerTexts()` | `locator.evaluateAll(els => els.map(e => e.innerText))` |
| `locator.getByRole()` | `page.getByRole(role, {name})` |
| `page.waitForFunction()` | poll `page.evaluate(...)` with `await sleep(200)` |
| `page.waitForNavigation()` | `page.waitForURL(...)` or `page.waitForLoadState()` |
| `page.context()` | none; use `openTab(url)` |

## Tab ownership

The user and other agents share the browser.
A tab belongs to the session that opened it with `open_tab()`, or with `openTab()` inside `run()`.
The record lives in `aside-browser-tabs.json` under `RLM_SESSION_DIR`, so it survives a kernel restart.

- Use `attach()` only when the task is about a page the user already has open.
- Otherwise use `open_tab()`, and call `close_own_tabs()` when done.
- `close_tab()` refuses tabs this session did not open, including attached tabs.
- `run()` refuses code that loops over `tabs` and closes them.
- Never call `page.close()`.
- Pass `force=True` only when the user asked for that tab to close.

## Site skills built into Aside

Gmail, Slack, Notion, Google Docs, Sheets and Search, YouTube, LinkedIn, and iMessage have REPL globals (`gmail`, `slack`, `notion`, ...) that often work without a tab.
Read the site skill before driving one of these sites by hand:

```bash
aside skills list
aside skills show google-gmail
```

Then call the documented global inside `await aside_browser("...")`.
For a multi-step task on these sites, `agent()` is usually cheaper, because it has the same skills and the user's memory.

## Outside sends

An email, a vendor ticket reply, or a message or post to someone outside goes out only after the owner approves it on a For you todo.

- Reading mail and filling a reply or compose box are allowed.
- Every REPL call, `run()` and the private `_repl()` alike, passes the send check.
- It refuses code that presses Send, or a send shortcut such as `Meta+Enter`, on a webmail page such as Gmail.
- It refuses code that submits, replies or presses Enter on a support ticket page or a contact form.
- It refuses code that posts, sends or presses Enter on X, LinkedIn, Discord, Facebook, Instagram, Reddit, WhatsApp web, Telegram web, or a GitHub page outside `sieu-n` and `virev-ai`.
- GitHub sign-in pages (`github.com/login`, `/login/oauth`, `/login/device` and `/sessions`) are no post, so an agent finishes a GitHub sign-in there itself (c4).
- It refuses the site skills' send calls (`linkedin.sendMessage`, `imessage.send` and the like) and any click or typing inside a support chat widget such as Intercom.
- It checks a click by coordinates, such as `page.mouse.click(x, y)`, when it runs: it reads the element under the point and refuses Send on a webmail page, Send or Submit on a ticket or social page, and a click into a support chat widget's frame.
- Each send it allows or refuses writes one line to the send log, which `board.sends()` reads.
- `agent()` refuses a task that asks the Aside agent to send or reply to an email, a ticket, or a message on those sites.
- Slack stays allowed, because both Slack workspaces are the owner's own.
- To send, draft the message and add a For you todo with the draft, the recipient, and choices such as "Send it" / "Not yet".
- After the owner approves the todo, pass `owner_ok="<chat id>/<todo id>"` to `run()` or `agent()`.
- The check reads the chat's board through `components/user-history/src/owner-ok.ts`: the todo must be checked off and answered by the owner with its first choice or another go.

## Rules

- Use no other browser automation: no CLI that launches its own browser, no headless browser, and no repo screenshot script.
- If a skill, playbook, or memory names another browser tool, change that text to `aside-browser`.
- The tab is the user's real window and cannot be resized.
- Screenshots are in device pixels, so read the viewport size and device pixel ratio before you crop for `attach_image`.
- Read pages with `snapshot()`, not `page.content()`.
- Each new snapshot invalidates old refs. Pass a ref as `page.locator('e12')`, never inside CSS.
- The REPL's `fs` only reaches the Aside session directory. `screenshot()` takes any local path; view the file with `attach_image`.
- `aside exec` sessions do not show in the chat list. Control them with `aside session list|resume|stop <id>`.
- Read the installed browser API with `aside guide repl`.

## Tests

From the repository root, `uv run python -m unittest discover -s skills/aside-browser/tests -v` runs the offline tests with a fake MCP server.
