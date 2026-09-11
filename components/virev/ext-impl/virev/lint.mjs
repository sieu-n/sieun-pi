// Report only: rewriting matches can corrupt quoted source.
import { lintText, summarize } from "./lint-core.mjs";
import { faultInject, featureEnabled, log } from "./log.mjs";

function assistantText(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	const parts = [];
	for (const block of message.content) {
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

export function onMessageEnd(event, ctx) {
	faultInject("lint", "outer");
	try {
		faultInject("lint", "inner");
		if (!featureEnabled("VIREV_LINT")) return undefined;
		const text = assistantText(event?.message);
		if (!text.trim()) return undefined;

		const hits = lintText(text);
		const summary = summarize(hits);
		const words = text.split(/\s+/).filter(Boolean).length;
		const top = Object.entries(summary.byRule)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([rule, n]) => `${rule} x${n}`)
			.join(", ");
		log(
			"lint",
			`${words} words, ${summary.hard} hard, ${summary.quoted} in quotes, ${summary.heuristic} heuristic${top ? ` :: ${top}` : ""}`,
		);
		try {
			ctx?.ui?.setStatus?.("virev-lint", summary.hard ? `unslop ${summary.hard}: ${top}` : undefined);
		} catch {
			// no UI in print or daemon mode
		}
		return undefined;
	} catch (err) {
		log("lint", `handler error, message left untouched: ${err?.message}`);
		return undefined;
	}
}
