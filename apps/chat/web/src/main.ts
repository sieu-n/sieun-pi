import { mount } from "svelte";
import "./styles/index.css";
import App from "./App.svelte";
import { restorePages } from "$lib/api";
import { watchReminders } from "$lib/remind-live";
import { watchNotices } from "$lib/notices.svelte";
import { later } from "$lib/later.svelte";
import { storeFirstViewAhead } from "./pages/usage/reports";
import { holdImages } from "$lib/held-images";
import { warmMarkdown } from "$lib/ui/markdown";

const target = document.getElementById("app");
if (!target) throw new Error("index.html has no #app element");
/** Waits for a later task, so the work after it starts a task of its own. */
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/**
 * The first render of markdown runs in a task of its own while IndexedDB reads, and the mount waits for a task after the reads. On 11-25 a
 * reload ran the read, the first markdown and the mount in one task of 164 to 196 ms at CPU rate 1 and 800 ms at rate 4
 * (~/work/p300-channel-open/trace-summary.md), which held the open's first answers behind it.
 */
setTimeout(warmMarkdown, 0);
// The kept pages come first, so the room and the thread of the address show from them in the first frame.
await restorePages();
// The sidebar's Later read goes out before the views mount, so the refreshes behind the kept pages and panels wait in the lane behind it
// (client.ts): on 11-21 a board refresh (42 KB) that started 44 ms ahead of it held it about 570 ms on a connection back in slow start
// (~/work/p155-readahead/lane-summary.md).
later.start();
watchReminders();
watchNotices();
holdImages(document.body);
await nextTask();
export default mount(App, { target });
storeFirstViewAhead();
