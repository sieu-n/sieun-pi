import { mount } from "svelte";
import "./styles/index.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("index.html has no #app element");
export default mount(App, { target });
