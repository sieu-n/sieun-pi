import { flushSync, mount } from "svelte";
import App from "./App.svelte";
import { APPEARANCE_KEY, applyAppearance, browserStorage, loadAppearance, parseAppearance } from "./appearance.ts";
import { releaseBootFeeds } from "./feeds.ts";
import { takeOver } from "./prepaint-swap.ts";
import "./app.css";
import "./prepaint.css";

applyAppearance(document, loadAppearance(browserStorage()));
// Another tab's pick: the storage event never fires in the tab that wrote it.
window.addEventListener("storage", event => { if (event.key === APPEARANCE_KEY) applyAppearance(document, parseAppearance(event.newValue)); });
const app = document.getElementById("app")!;
mount(App, { target: app });
// The app has now subscribed the feeds it shows, and took those the shell's boot socket had started; the rest stop.
flushSync();
releaseBootFeeds();
const prepaint = document.getElementById("prepaint");
if (prepaint) takeOver(prepaint, app);
