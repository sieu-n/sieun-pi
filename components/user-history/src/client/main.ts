import { mount } from "svelte";
import App from "./App.svelte";
import { APPEARANCE_KEY, applyAppearance, browserStorage, loadAppearance, parseAppearance } from "./appearance.ts";
import "./app.css";

applyAppearance(document, loadAppearance(browserStorage()));
// Another tab's pick: the storage event never fires in the tab that wrote it.
window.addEventListener("storage", event => { if (event.key === APPEARANCE_KEY) applyAppearance(document, parseAppearance(event.newValue)); });
mount(App, { target: document.getElementById("app")! });
