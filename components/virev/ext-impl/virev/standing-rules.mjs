import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { faultInject, featureEnabled, log } from "./log.mjs";

export const MARKER = "VIREV-STANDING-RULES-V1";
export const DOCUMENT_MARKER = "VIREV-UNSLOP-DOCUMENT-V1";

let baseDir = dirname(fileURLToPath(import.meta.url));
/** @type {string | null} */
let block = null;
let attempted = false;
/** @type {string | null} */
let doc = null;
let docAttempted = false;

/** @param {string} dir */
export function setBaseDir(dir) {
	baseDir = realpathSync(dir);
	block = null;
	attempted = false;
	doc = null;
	docAttempted = false;
}

export function loadRules() {
	if (attempted) return block;
	attempted = true;
	const path = join(baseDir, "standing-rules.md");
	try {
		const text = readFileSync(path, "utf8").trim();
		if (!text.includes(MARKER)) {
			log("standing-rules", `disabled: ${path} does not contain ${MARKER}`);
			return null;
		}
		block = `\n\n${text}\n`;
		log("standing-rules", `loaded ${text.length} chars from ${path}`);
	} catch (err) {
		log("standing-rules", `disabled: ${err instanceof Error ? err.message : String(err)}`);
	}
	return block;
}

export function loadDoc() {
	if (docAttempted) return doc;
	docAttempted = true;
	const path = process.env.VIREV_UNSLOP_DOC || resolve(baseDir, "../../../../skills/unslop/SKILL.md");
	try {
		doc = readFileSync(path, "utf8").trim();
		log("standing-rules", `doc loaded, ${doc.length} chars from ${path}`);
	} catch (err) {
		log("standing-rules", `doc unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}
	return doc;
}

export function onSessionStart() {
	if (featureEnabled("VIREV_STANDING_RULES")) {
		loadRules();
		loadDoc();
	}
}

/** @type {import("prime-agent").ExtensionHandler<import("prime-agent").BeforeAgentStartEvent, import("prime-agent").BeforeAgentStartEventResult>} */
export function onBeforeAgentStart(event) {
	faultInject("standing-rules", "outer");
	try {
		faultInject("standing-rules", "inner");
		if (!featureEnabled("VIREV_STANDING_RULES")) return undefined;
		let systemPrompt = event.systemPrompt;
		const rules = loadRules();
		if (rules && !systemPrompt.includes(MARKER)) systemPrompt += rules;
		const document = loadDoc();
		if (document && !systemPrompt.includes(DOCUMENT_MARKER)) {
			systemPrompt += `\n\n# Writing standard source, marker ${DOCUMENT_MARKER}\n\n${document}\n`;
		}
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	} catch (err) {
		log("standing-rules", `prompt left unchanged: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}
