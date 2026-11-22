/**
 * Links from a curated page into a session folder. A session folder is `sessions/YYYY/MM/DD/<slug>`, or
 * `agents/<agent>/jobs/YYYY/MM/DD/<slug>` for a pi-host job folder, and its one API-managed log is `index.html`. Every
 * other file there is a working artifact the curated pages must not depend on. The sessionLinks lint
 * (src/lib/server/wiki-lint.ts), which the wiki dream precheck counts, and the prose lint's session-link rule
 * (src/lib/prose-lint.mjs), which the page API runs on every write, both read this one definition.
 */

/** Everything under sessions/ or under an agent's jobs/ folder. */
const SESSION_AREA = /^(?:sessions|agents\/[^/]+\/jobs)\//;
/** The session folder a path sits in, as group 1. */
const SESSION_FOLDER = /^((?:sessions|agents\/[^/]+\/jobs)\/\d{4}\/\d{2}\/\d{2}\/[^/]+)(?:\/|$)/;

/**
 * True for a session folder's log, `<folder>/index.html`.
 * @param {string} rel content-relative path
 */
export function isSessionLogPath(rel) {
	const folder = SESSION_FOLDER.exec(rel)?.[1];
	return folder !== undefined && rel === `${folder}/index.html`;
}

/**
 * The finding for a curated page's link to content path `target`: null when the target is outside the session area,
 * is a folder's log, or is the folder itself (which serves its log); else the target and the log to link instead,
 * null for a target above the folder level such as `sessions/2026/11/`.
 * @param {string} target content-relative path
 * @returns {{ target: string, log: string | null } | null}
 */
export function sessionFolderLink(target) {
	const rel = target.replace(/\/$/, '');
	if (!SESSION_AREA.test(rel) || isSessionLogPath(rel)) return null;
	const folder = SESSION_FOLDER.exec(rel)?.[1];
	if (folder === rel) return null;
	return { target: rel, log: folder === undefined ? null : `${folder}/index.html` };
}
