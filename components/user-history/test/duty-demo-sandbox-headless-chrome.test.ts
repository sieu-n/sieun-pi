// Guards d1's run detail after 10-19 about 12:20Z, when about 18 headless Chrome shot browsers from demo jobs ran on the Mac at once, its load hit 78
// and 5180's /health went unanswered for 120 s, and no d1 line showed the pile-up. The lines below are the Mac's `ps -axo pid=,ppid=,args=` of 10-19.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headlessChrome } from "../scripts/duties/demo-sandbox.ts";

const shell = "/Users/sieunpark/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const ps = [
  "50452     1 node motion-sprites.mjs",
  `50562 50452 ${shell} --disable-field-trial-config --headless --no-sandbox --user-data-dir=/tmp/playwright_chromiumdev_profile-a`,
  `50565 50562 ${shell} --type=gpu-process --no-sandbox`,
  `50566 50562 ${shell} --type=utility --utility-sub-type=network.mojom.NetworkService`,
  `80694 50562 ${shell} --type=renderer --headless=old --no-sandbox`,
  `60001     1 ${shell} --headless=new --remote-debugging-pipe`,
  "41331     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  " 2249 41331 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/155.0.8059.84/Helpers/Google Chrome Helper (Aperitif Renderer).app/Contents/MacOS/Google Chrome Helper (Aperitif Renderer) --type=renderer",
  "70000     1 node vite dev --headless-mode-flag",
].join("\n");

test("headless_chrome counts each headless browser and the processes under it, and skips the owner's windowed Chrome", () => {
  assert.deepEqual(headlessChrome(ps), { browsers: 2, processes: 5 });
  assert.deepEqual(headlessChrome("  1 0 /sbin/launchd\n"), { browsers: 0, processes: 0 });
});
