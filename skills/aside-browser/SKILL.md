---
name: aside-browser
description: "The browser for any web page task: open, read, click, fill, scrape, or screenshot sites and our own apps. Every page that needs no login opens in a headful Chrome on a Linux box, also for a job on the owner's Mac, and only a site that needs his login opens in his Aside on the Mac."
---

# aside-browser

On a Linux box, `open_tab(url)` and `run(code)` drive a headful Google Chrome on that box by default, with no flag.
Each kernel gets its own Chrome on its own Xvfb display, with its own profile folder, and all three go away when the kernel exits.
The owner's Aside browser on his Mac is the exception, used only for a site that needs one of his logins, and it is the only browser on the Mac itself.
A kernel on the Mac drives a box Chrome on us-metal02 over ssh for every other page, and that Chrome reaches the Mac's own dev servers, such as `localhost:5180`, through an ssh SOCKS tunnel back to the Mac (`box/loopback.mjs`).
Both browsers take the same Playwright-style REPL globals, so the same code runs in either.
Aside has no Linux build, because aside.com/download offers only macOS and Windows and docs.aside.com/help/get-started names macOS 15.0 or later (checked 2026-10-27), and the Linux `aside` CLI only reaches a running Aside elsewhere.
So the owner picked this split on 2026-10-27 (msg mvqbc3ep): his Aside on the Mac for pages that need his login, and the box's headful Chrome for pages with no login, such as local frontend checks.
Never install Aside on a box or add a headless browser in place of the box Chrome (c177).

## Setup

On a Linux box:

1. Install the box runner once with `cd skills/aside-browser/box && npm ci`, which needs `node`.
2. Chrome comes from `/usr/bin/google-chrome`, or Playwright's Chromium in `~/.cache/ms-playwright` when that is missing, and `BOX_CHROME` names another binary.
3. Xvfb comes from `~/.local/opt/xvfb` as `deploy/linux/README.md` (Tools, steps 3 and 4) unpacks it, or `Xvfb` on `PATH`, or `BOX_XVFB`. Without Xvfb the runner exits with an error, because no agent browser runs headless (c177).

For the owner's Aside, on the Mac or for login pages from a box:

1. Install Aside and its CLI, and keep Aside.app running.
2. Check the signed-in account with `aside account status`, because a profile may not be signed in.
3. Add an `aside` stdio MCP server to the Prime Agent profile with `command: aside`, `args: [mcp]` and `callTimeoutMs: 130000`.
4. Put the CLI on the MCP process's `PATH`, or use its absolute path as the MCP command.
5. Start a new session or run `/reload`, because Prime Agent reads MCP settings only then.
6. Check access with `await aside_browser.tabs(browser="aside")`.

Without the MCP server, each call runs the one-shot CLI, and its output starts with `[aside-browser fallback]`.
The fallback keeps no state between calls, so multi-step tab work needs the MCP server.
The fallback looks for the CLI at `ASIDE_CLI`, then `aside` on `PATH`, then `~/.local/bin/aside`, so set `ASIDE_CLI` before the skill loads.

## Calls

```python
await aside_browser("return await page.title()")   # run REPL JS; `return value` prints it (`aside guide repl`)
await aside_browser.tabs()                       # [{targetId, active, title, url, owned, browser}]; on a box only its own tabs
await aside_browser.tabs(browser="aside")        # the owner's Aside tabs, only when the task is about one of them
await aside_browser.open_tab(url)                # sets `page`; replaces this session's earlier tab; the box's Chrome unless the URL needs a login
await aside_browser.open_tab(url, keep=True)     # also keep this session's earlier tabs open, such as for a side-by-side compare
await aside_browser.open_tab(url, browser="aside")  # only for a page that needs the owner's login, such as a box page that hit a sign-in
await aside_browser.attach(target_id=None)       # reuse a tab the user has open (None = active tab); not owned
await aside_browser.snapshot(interactive=True)   # a11y tree with [ref=eN]; then page.locator('eN').click()
await aside_browser.screenshot('/abs/path.png', full_page=False, annotated=False)  # copies the PNG out of the sandbox
await aside_browser.close_tab()                  # current tab, only if this session opened it
await aside_browser.close_tab(target_id)         # one owned tab; force=True closes any tab
await aside_browser.close_own_tabs()             # every tab this session opened, Aside and box
await aside_browser.owned_tabs()                 # open tabs this session opened
await aside_browser.sweep_stale_tabs()           # close Aside tabs whose agent kernel has exited
await aside_browser.agent("Find the unread Slack message from Alex")   # delegate to the Aside agent; returns session_id
await aside_browser.agent("continue", session_id="...")
await aside_browser.memory_search("what does the user work on")
```

`await aside_browser(code)` is `run(code, title="aside repl", wrap=True, force=False, owner_ok=None)`.

- Each call runs inside an async function, so the next call can reuse a `const` or `let` name.
- `page`, `tabs` and the other REPL globals persist between calls.
- To keep a value for a later call, set `globalThis.name = value`.
- `wrap=False` runs the code in the REPL's shared top-level scope.
- Every tab a call opens, by `openTab()`, a click or any other way, is recorded as this session's, so the end of the job's turn closes it. A raw `aside repl` or `mcp.call_tool("aside", ...)` call records nothing, so open tabs only through this skill.
- Each REPL call times out after 120 s, so hand a long multi-step task to `agent()`.

## Errors

Errors raise `AsideError`. For a known mistake, the message ends with an `[aside-browser hint]` line that names the fix.

- Page globals such as `document`, `window` and `location` do not exist in the REPL, so read them with `await page.evaluate(() => document.title)`.
- REPL helpers such as `sleep` and `page` do not exist inside `page.evaluate`, so wait there with `await new Promise(r => setTimeout(r, ms))`.
- "fetch failed: other side closed" followed by "Aside isn't running on this machine" after a call of 120 s means the call ran past Aside's 120 s limit per call, and Aside is still up. Between 13:23Z on 10-27 and 23:44Z the 5180 jobs read it 104 times while Aside had run for 9 days and its daemon for 43 h, so `run()` now names the limit instead, and a call that polls or waits for a page keeps its own timeout well under 120 s and repeats from Python.
- "Profile 0 is not connected to the daemon" means the owner's Aside has no open window, because the profile's bridge needs one, so it comes back only when he opens a window. Never quit, restart or open Aside windows on his Mac yourself (c103); on 2026-10-22 he closed his last window at 01:08Z and a job blamed its own 1 MB upload.

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

In the owner's Aside, `screenshot(path, full_page=True)` and `page.screenshot({fullPage: true})` return an image of the full page height that repeats the first viewport. On 2026-10-08 a 2101 px static page came back as its first 900 px three times. To capture a page taller than the window there, scroll with `window.scrollTo` in `innerHeight` steps, take a viewport screenshot at each step, paste each tile into one image at `scrollY * devicePixelRatio`, and crop to the element you want.

## Tab ownership

The user and other agents share the browser.
A tab belongs to the session that opened it with `open_tab()`, or with `openTab()` inside `run()`.
The module records owned Aside tabs, with the kernel's pid, in one file per session under `~/.local/state/aside-browser/owners` (`ASIDE_BROWSER_STATE`), so the record survives a kernel restart.

- Use `attach()` only when the task is about a page the user already has open.
- Otherwise open your own tab with `open_tab()`, and call `close_own_tabs()` when done.
- `open_tab()` closes this session's earlier tabs in the same browser, so a job holds one tab at a time. Pass `keep=True` only when you need two pages open at once. On 2026-10-28 jobs held up to 4 Aside tabs each, and 36 tabs used 8.3 GB on the owner's Mac.
- A job's Aside tab on a local app, such as `http://[::1]:5180`, closes after 120 s with no aside_browser call, and the next `run()`, `snapshot()` or `screenshot()` opens its last URL again and prints a line that says so. Clicks, scroll and typed text from before that line are gone, so redo them. A top-level chat's tabs and the tab the Aside window shows stay open.
- Go to another page in your tab with `page.goto(url)` when you can, instead of opening a new one.
- A job's Aside tabs close when its turn ends, because sieun-rules' `aside-tabs.ts` runs `close_own_tabs()` for any subagent session at `agent_end`. On 2026-10-29 the kernels of finished jobs stayed alive, and 15 of the 17 tabs in the owner's Aside belonged to jobs that had ended their turn.
- A top-level chat keeps its tabs after its turn ends, so it can leave a page open for the owner, and it closes them with `close_own_tabs()` when he is done.
- `open_tab()` and `tabs()` also close the Aside tabs of any agent kernel on this host that has exited.
- Tabs the owner opened have no record, so no sweep or close touches them.
- In Aside, `closeTab()` of a tab that another REPL session opened only drops it from your session and leaves it open, and every kernel has its own session. The module's closes check the tab list afterwards and send Page.close to a tab that is still there, and a sweep keeps the record of a tab that did not close. Before 2026-10-28 sweeps dropped the records and left 25 job tabs open with no owner.
- Aside leaves a tab out of its tab list until the tab's first page loads, and another REPL session cannot attach it then, so a close keeps the record of such a tab for 15 min after it opened and a later close or idle close takes it. Before 2026-10-29 closes dropped those records, and four 5180 tabs that loaded slowly under the Mac's load stayed open with no owner.
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
| X, LinkedIn, Discord, Facebook, Instagram, Reddit, WhatsApp web, Telegram web, a GitHub page outside `sieu-n`, `virev-ai` and the owner's own `/settings` | post, send or Enter |
| Site skill send calls | `linkedin.sendMessage`, `imessage.send` and the like |
| Support chat widget such as Intercom | any click or typing |
| `agent()` | a task that asks the Aside agent to send or reply to an email, a ticket, or a message on those sites |

A click by coordinates, such as `page.mouse.click(x, y)`, is checked when it runs.
The check reads the element under the point and refuses Send on a webmail page, Send or Submit on a ticket or social page, and a click into a support chat widget's frame.
On a social page the check reads the REPL code itself, so code that pairs a click or `keyboard.press` with Enter or a Send, Submit, Reply or Post word is refused even when the page sends nothing (`_sends` in `src/aside_browser/__init__.py`). On 2026-10-18 the CI GitHub App setup job hit that on `github.com/apps/<app>/installations/new`, a GitHub page outside `sieu-n`, `virev-ai` and `/settings`, and a click on a button picked by a label without those words, such as `getByRole('button', {name: 'Save'})`, or by its id passed.

GitHub sign-in pages (`github.com/login`, `/login/oauth`, `/login/device` and `/sessions`) count as no post, so an agent finishes a GitHub sign-in there itself (c4).
Slack stays allowed, because both Slack workspaces are the owner's own.
Each send the check allows or refuses writes one line to the send log, which `board.sends()` reads.

To send:

1. Draft the message.
2. Add a For you todo with the draft, the recipient, and choices such as "Send it" / "Not yet".
3. After the owner approves the todo, pass `owner_ok="<chat id>/<todo id>"` to `run()` or `agent()`.

The check reads the chat's board through `legacy/prime/user-history/src/owner-ok.ts` in the sieun-pi repo.
The todo must be checked off and answered by the owner with its first choice or another go.
The check also gets the page URL, so when one todo asks about two sites and the answer splits, as in "no to Kaggle, yes to Reddit", only the site he said yes to passes.

## Which browser opens a page

On a Linux box the default is the box's own headful Chrome:

1. `open_tab(url)` with no `browser` opens the page in the box's Chrome, because every Aside tab renders on the owner's Mac, even in the background.
2. `run(code)` before any tab runs in the box's Chrome, and `openTab('<url>')` inside `run()` picks its browser by that URL in the same way.
3. Our own apps (`localhost`, `127.0.0.1`, `[::1]`, the tailnet), public pages and demo pages such as `http://[::1]:5180` always open on the box.
4. Only a page that needs one of the owner's logins opens in his Aside: a host in `LOGIN_HOSTS` (Google, GitHub, vendor dashboards, social sites), a mail, ticket or social page, or a non-http URL (c82, c103).
5. `agent()`, `memory_search()` and the site skill globals (`gmail`, `slack`, `googleDocs` and the rest) run in Aside, because they exist only there.
6. When a box page lands on a sign-in page, the result says so, and only then you open it again with `open_tab(url, browser="aside")`.
7. When an Aside page lands on a sign-in page, click its Sign in, Continue or Google button yourself before you decide no login is saved, because Chrome hides the owner's saved email and password from scripts and snapshots until a real click. On 10-19 a job read empty boxes on Cloudflare's sign-in page in Aside and asked the owner to sign in while Aside held his saved login (c129), so `open_tab` now says this on every Aside sign-in page.

On the owner's Mac the same split holds, and the box is us-metal02 (`ASIDE_BROWSER_BOX_HOST`):

1. `open_tab(url)` for a page with no login starts this kernel's box runner on us-metal02 over `ssh -T`, which runs `box.mjs` from `~/.prime/agent/skills/aside-browser/box` there.
2. That runner opens `ssh -D` back to the Mac (`ASIDE_BROWSER_LOOPBACK_HOST`, default `mac`) and sends Chrome's requests through it, so `http://localhost:5180`, `http://[::1]:5180` and `http://cc.localhost:5180` load the Mac's own servers with the Mac's uncommitted edits.
3. The page renders on us-metal02, so it takes no memory in the owner's Aside, and `screenshot()` still writes its PNG on the Mac.
4. The REPL's `fs` in a box tab is us-metal02's file system, so pass files back through `screenshot()` or the call's output.

On 2026-10-29 the Mac read unusable from 14:42Z while agents' Aside tabs held 12 of 25 tabs at 4.22 GB (15:06Z) and 16 of 31 at 5.34 GB (15:21Z), nearly all on `localhost:5180` and `:5174`, and at 16:40Z at least 5 of the agents' local-app tabs had no owner record, so no park, job end or sweep could close them.
A Mac page load takes longer this way, because each request crosses the ssh tunnel at about 190 ms: on 10-29 the 5174 landing page with 250 resources loaded in 22 s, and staging.virev.ai in 5.7 s.
With `ASIDE_BROWSER_BOX=0` every page opens in Aside, and nothing else may open a window on the Mac.
An agent on the Mac never launches a Playwright, Puppeteer or Chrome for Testing browser there either, headless included, because Mac browsers pushed its load to 110 to 170 and froze 5180 on 10-19.

- A script browser, such as a rig that loads an unpacked extension into a persistent profile, runs on us-metal02: copy the files with `scp` or `rsync`, then run it with `ssh us-metal02`, which loads `playwright-core` from `~/.prime/agent/skills/aside-browser/box/node_modules` with the `no-netlink-chromium.py` wrapper there.
- A check of the Mac's 5180 demo page runs in a box tab through this skill as above, and the Chat page from the Mac duty's timing runs in an Aside tab, because every headless browser was removed on 10-27 and nobody adds one back (c177).
- The Whole system duty (d7) counts every Chrome for Testing and chrome-headless-shell on the Mac as `mac_test_browsers` and names the session that started each one.

## Browser rules

- A box agent never sends non-login work to the Mac, so it never runs Playwright, a screenshot script or cua-driver over `ssh mac`, and never tunnels a Mac port to look at a page the box can serve itself. The skill's own tunnel for a Mac kernel's box tab is the one exception, because only the Mac serves its uncommitted edits.
- Repo Playwright specs and shot scripts on a box launch their own headful Chrome on a fresh Xvfb display, as the repo's `playwright.config.ts` files and `auto-sns-agent/packages/config/box-browser.mjs` set up.
- Use no other browser automation, such as a CLI that launches a browser of its own.
- If a skill, playbook or memory names another browser tool, or sends a box agent to Aside for a page that needs no login, change that text.
- Box tabs have targetIds `box-1`, `box-2` and so on, and they close when your kernel exits.
- Each box browser is a separate Chrome with its own display and profile, so any number of agents can run one at once, and none of them sees another's cookies or tabs.
- In a box tab, `snapshot()` returns Playwright's full AI snapshot with `[ref=eN]` ids, `annotatedScreenshot` has no ref boxes, `fs` is the box's real file system, and `page.setViewportSize()` works.
- Screenshots are in device pixels, so read the viewport size and device pixel ratio before you crop for `attach_image`.
- Read pages with `snapshot()`, not `page.content()`.
- Pass a ref from the latest snapshot as `page.locator('e12')`, never inside a CSS selector, because each new snapshot invalidates the old refs.
- The Aside REPL's `fs` reaches only the Aside session directory, while `screenshot()` writes to any local path that you then view with `attach_image`.
- `aside exec` sessions do not show in the chat list, so control them with `aside session list|resume|stop <id>`.

## Tests

From the sieun-pi repository root, `uv run python -m unittest discover -s skills/aside-browser/tests -v` runs the offline tests with a fake MCP server, plus two box tests when the runner is installed: one serves a page on 127.0.0.1 and drives it, and one checks that Chrome runs headful on its own Xvfb display and that a SIGKILL of the runner leaves no Xvfb or Chrome behind.
