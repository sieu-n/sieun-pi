---
name: mac-screen
description: "Use when a task needs the owner's own Mac screen or his signed-in desktop Chrome, such as a dashboard open only in his Chrome, and he asked for it. Takes a screenshot of his Mac and clicks, types and presses keys there through CuaDriver over ssh, from any box."
---

# mac-screen

`mac-screen.py` drives the owner's Mac (`sieunpark@100.66.173.18`) through CuaDriver, the trycua `cua-driver` app in `/Applications/CuaDriver.app`.
CuaDriver already holds the Mac's Accessibility and Screen Recording grants, so nothing needs a new grant.
Plain ssh holds neither, so `screencapture`, `osascript` System Events and `cliclick` fail over ssh.
The script starts the CuaDriver daemon in the background when it is not running, then runs `cua-driver call <tool> <json>` on the Mac.
On the Mac itself it runs the same commands without ssh, and `MAC_SCREEN_HOST` names another host.

Use it only for a window the owner named in his ask, because owner rule c103 keeps agents off his screen otherwise.
A click or key press that sends mail or a message still needs his ok on a For you todo first (c37).

## Commands

```sh
S=~/.prime/agent/skills/mac-screen/mac-screen.py
python3 $S shot [out.png] [--max N]   # prints the local PNG path, then the sizes and scale as JSON
python3 $S front                      # frontmost app, bundle id, pid, window id and title
python3 $S click X Y [--double] [--right]
python3 $S type "text"                # into the focused element of the frontmost app
python3 $S key cmd+l                  # one key (return, tab, escape) or a combo
python3 $S call TOOL '{"json": 1}'    # any cua-driver tool
python3 $S --dry-run click 300 200    # prints the ssh command and sends nothing
```

`shot` caps the long edge at 1366 pixels by default, and `--max 0` keeps the full 3600x2338 Retina size.
`click X Y` takes pixels of the last `shot`, and CuaDriver maps them to screen points through that shot's `capture_id`.
A capture is good for one click, so take a new shot before the next click.

## Screenshot loop

1. Run `shot` and load the PNG with `await attach_image.run(path)`.
2. Read where the target is, and act with `click`, `type` or `key`.
3. Run `shot` again and check that the screen changed the way you expected, before the next step.

## One window in the background

A desktop `click` posts a real mouse event at that spot on his screen.
To work in one window without moving his pointer or focus, use the window tools through `call`:

1. Run `call list_windows '{"app":"Google Chrome"}'` and take the `pid` and `window_id` of the window whose `title` matches.
2. Run `call get_window_state '{"pid":P,"window_id":W,"include_screenshot":false}'`, which returns the window's accessibility tree with element tokens such as `s0000002a:11`.
3. Run `call click '{"element_token":"s0000002a:11"}'` or `call type_text '{"element_token":"...","text":"..."}'`.

A token goes stale after the next `get_window_state` of that window.
To read a tool's arguments, run `ssh sieunpark@100.66.173.18 '~/.local/bin/cua-driver describe click'`.
