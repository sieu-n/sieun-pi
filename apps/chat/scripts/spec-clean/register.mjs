// Loaded with --import (scripts/spec-clean.mjs puts it in NODE_OPTIONS) before tsx and Playwright register theirs, so both read through it.
import { registerHooks } from "node:module";
import { overlayFromEnv, overlayHooks } from "./overlay.mjs";

const overlay = overlayFromEnv();
if (overlay) registerHooks(overlayHooks(overlay, process.env.SPEC_CLEAN_MODE === "redirect" ? "redirect" : "source"));
