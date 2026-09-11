---
name: aside-browser
description: The browser for this machine. Drives the user's Aside browser (their real logged-in tabs, cookies, and sessions) from the Python kernel. Use whenever a task touches a web page - open a site, load or read Gmail, Slack, Notion, GitHub, Linear, Stripe or any dashboard, take a screenshot, click or fill a form, scrape or extract data, test, QA, dogfood or screenshot our own apps on localhost or a deployed URL, or hand a whole browsing task to the Aside agent. Also for "aside", "aside repl", "aside exec", and Aside memory searches.
---

# aside-browser

This skill drives a separately installed Aside browser through Prime Agent's Python host.
It uses the `aside` MCP server and its `repl`, `exec` and `memory_search` tools.
Browser tasks include local pages, deployed apps and sites where the user has signed in.
Installing this skill does not install Aside, sign in to accounts or configure MCP.

## Prerequisites and setup

- Install Aside and its CLI separately. Keep Aside.app running when using browser tools.
- Configure any required account access in Aside. Check its setup with `aside account status`; do not assume a profile is signed in.
- Use this skill inside Prime Agent, which supplies `rlm.mcp` and the callable module wrapper.
- Configure an `aside` stdio MCP server in the active Prime Agent profile with `command: aside`, `args: [mcp]` and `callTimeoutMs: 130000`.
- Make the CLI available on the MCP process's `PATH`, or use its installed absolute path as the MCP command.
- The skill's CLI fallback resolves `ASIDE_CLI`, then `aside` on `PATH`, then `~/.local/bin/aside`. Set `ASIDE_CLI` before loading the skill if needed; it does not change the MCP server command.
- Prime Agent reads MCP settings at session start or `/reload`. Without that server, the skill uses one-shot CLI calls whose output starts with `[aside-browser fallback]`.
- CLI fallback does not keep state between calls. Configure the MCP server for multi-step tab work and diagram capture.
- Check browser access with `await aside_browser.tabs()` after setup.

## Calls

```python
await aside_browser("const p = await openTab('https://example.com'); console.log(await p.title())")   # any REPL JS on the `page` object (`aside guide repl`)
await aside_browser.tabs()                       # [{targetId, active, title, url}]
await aside_browser.open_tab(url)                # sets `page`
await aside_browser.attach(target_id=None)       # reuse a tab the user already has open (None = active tab)
await aside_browser.snapshot(interactive=True)   # a11y tree with [ref=eN]; then page.locator('eN').click()
await aside_browser.screenshot('/abs/path.png', full_page=False, annotated=False)  # copies the PNG out of the sandbox
await aside_browser.close_tab()
await aside_browser.agent("Find the unread Slack message from Alex")              # delegate to the Aside agent; returns session_id
await aside_browser.agent("continue", session_id="...")
await aside_browser.memory_search("what does the user work on")
```

MCP REPL calls share one persistent scope: `page`, `tabs`, and every `const`/`let` survive between calls until the REPL idles for 30 min. Use fresh variable names per call. Errors raise `AsideError`.

## Site skills built into Aside

Gmail, Slack, Notion, Google Docs/Sheets/Search, YouTube, LinkedIn, iMessage have ready-made REPL globals (`gmail`, `slack`, `notion`, ...) that often work without opening a tab. Before driving one of these sites by hand, read the skill and follow it:

```bash
aside skills list
aside skills show google-gmail
```

Then call the documented global inside `await aside_browser("...")`. For a multi-step task on those sites, `agent()` is usually cheaper: it has the same skills plus the user's memory.

## Rules that matter

- This is the only browser tool. Never run any other browser automation: no CLI that launches its own browser, no headless browser, no repo screenshot script. When a skill, playbook, or memory names another tool, edit that text to `aside-browser` on sight.
- The tab is the user's real window. `page.setViewportSize` and `page.waitForTimeout` do not exist in the REPL; use `await sleep(ms)` and take the size as it is. Screenshots use device pixels. Read the current viewport size and device pixel ratio before cropping with PIL for `attach_image`.

- Read pages with `snapshot()`, not `page.content()`. Refs (`e12`) are invalidated by every new snapshot. Pass them as `page.locator('e12')`, never inside CSS.
- Only touch the user's existing tabs with `attach()` when the task is about a page they have open. Otherwise `open_tab()` and `close_tab()` when done. Never `page.close()` or `context().newPage()`.
- The REPL's `fs` is sandboxed to the active Aside session directory; absolute paths are refused. `screenshot()` moves bytes out through base64, so pass any local path, then view it with `attach_image`.
- 120 s per call. Long tasks with many steps: prefer `agent()`.
- `aside exec` sessions stay off the chat list; `aside session list|resume|stop <id>` from the shell controls them.
- Read the installed browser API with `aside guide repl`. The vendor reference is not redistributed in this package.

## Verify after changes

```python
print(await aside_browser("console.log((await listBrowserTabs()).length)"))
```
