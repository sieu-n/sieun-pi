import * as gitGuard from "./git-guard.mjs";
import * as lint from "./lint.mjs";
import { log } from "./log.mjs";
import * as standingRules from "./standing-rules.mjs";

export const IMPL_VERSION = "v2";

/** @param {{ implDir: string }} options */
export function init({ implDir }) {
	standingRules.setBaseDir(implDir);
	log("impl", `init ${IMPL_VERSION} from ${implDir}`);
}

export function describe() {
	return `${IMPL_VERSION} git-guard+standing-rules+lint`;
}

export const onSessionStart = standingRules.onSessionStart;
export const onToolCall = gitGuard.onToolCall;
export const onBeforeAgentStart = standingRules.onBeforeAgentStart;

/** @type {import("prime-agent").ExtensionHandler<Extract<import("prime-agent").ExtensionEvent, { type: "message_end" }>>} */
export function onMessageEnd(event, ctx) {
	lint.onMessageEnd(event, ctx);
}
