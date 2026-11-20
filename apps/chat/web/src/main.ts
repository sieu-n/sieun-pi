import { mount } from "svelte";
import "./styles/index.css";
import App from "./App.svelte";
import { restorePages } from "$lib/api";
import { watchReminders } from "$lib/remind-live";

const target = document.getElementById("app");
if (!target) throw new Error("index.html has no #app element");
// The kept pages come first, so the room and the thread of the address show from them in the first frame.
await restorePages();
watchReminders();
export default mount(App, { target });
