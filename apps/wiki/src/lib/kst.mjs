// Wiki calendar in Korea time. The wiki names session folders `sessions/YYYY/MM/DD/hhmm-slug/`
// and stamps `created`, `date` and `updated` in Asia/Seoul on every host.
//
// Never use `getHours()` or `toISOString()` for these: on a UTC host they name the wrong hour or
// day, and a folder can collide with one another host made a day earlier.
//
// Pure module, no dependencies. wiki-sessions.ts, wiki-logs.ts and scripts/wiki-health.mjs import it.

export const WIKI_TIME_ZONE = 'Asia/Seoul';

/** Korea has kept UTC+9 with no daylight saving since 1988. */
const KST_OFFSET_HOURS = 9;

const FORMAT = new Intl.DateTimeFormat('en-CA', {
	timeZone: WIKI_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/**
 * The Korea wall clock of an instant as zero-padded strings.
 * @param {Date} [date]
 * @returns {{ year: string, month: string, day: string, hour: string, minute: string }}
 */
export function kstParts(date = new Date()) {
	/** @type {Record<string, string>} */
	const parts = {};
	for (const part of FORMAT.formatToParts(date)) parts[part.type] = part.value;
	return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/**
 * The Korea day of an instant, `YYYY-MM-DD`, for `created`, `date` and `updated`.
 * @param {Date} [date]
 */
export function kstDay(date = new Date()) {
	const p = kstParts(date);
	return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The day folder of an instant under `sessions/`, `YYYY/MM/DD`.
 * @param {Date} [date]
 */
export function kstDayFolder(date = new Date()) {
	const p = kstParts(date);
	return `${p.year}/${p.month}/${p.day}`;
}

/**
 * The session folder of an instant under `sessions/`, `YYYY/MM/DD/hhmm-slug`.
 * @param {Date} date
 * @param {string} slug
 */
export function kstSessionFolder(date, slug) {
	const p = kstParts(date);
	return `${p.year}/${p.month}/${p.day}/${p.hour}${p.minute}-${slug}`;
}

/**
 * The instant a Korea wall clock names, such as the `YYYY/MM/DD/hhmm` of a session folder.
 * @param {number} year
 * @param {number} month 1 to 12
 * @param {number} day
 * @param {number} [hour]
 * @param {number} [minute]
 */
export function kstWallClock(year, month, day, hour = 0, minute = 0) {
	return new Date(Date.UTC(year, month - 1, day, hour - KST_OFFSET_HOURS, minute));
}
