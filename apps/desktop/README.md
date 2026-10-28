# apps/desktop

The Mac app of apps/chat. It is a Tauri 2 window named Sieun Chat that loads the chat from the box at https://us-metal02-dev.tail0c093d.ts.net:5184, so a web release of apps/chat needs no Mac build.

The Rust shell only wires the window, the menu and links, and the chat itself stays in apps/chat.

- The box URL is the `main` window's `url` in `src-tauri/tauri.conf.json`, and `npm run check` at the repo root fails when that file does not parse or the URL is not https.
- At start and on Cmd+R the window opens `src/index.html`, which checks that the box answers and then loads the chat, or shows a retry page when the Mac is off the tailnet.
- A link to any other site opens in the default browser.
- The window remembers its size and position through tauri-plugin-window-state.
- The menu has the usual macOS App, Edit (copy, paste, undo), View (Reload, full screen) and Window items.

## Build on the Mac

```sh
cd apps/desktop
npm ci
npm run tauri build
rm -rf "/Applications/Sieun Chat.app"
cp -R "src-tauri/target/release/bundle/macos/Sieun Chat.app" /Applications/
```

The build needs Rust from rustup and the Xcode command line tools. The bundle is signed ad hoc (`signingIdentity: "-"`) and is not notarized, so macOS may ask to confirm the first open.

## Icon

`icon.svg` is the source. After an edit, run `npx tauri icon icon.svg -o src-tauri/icons` and keep only the five files that `bundle.icon` lists.
