import { clearWindow, sanitize } from 'isomorphic-dompurify';

/**
 * Sanitize HTML in a fresh jsdom window. isomorphic-dompurify parses every call in one shared window, and jsdom adds
 * each parsed element that has an id to that window's named-property map, which nothing clears, so every page render
 * kept its whole DOM. A heap snapshot of the live wiki on 2026-10-29 after 20 hours found that map holding 2.4 GB of
 * the 2.9 GB heap.
 * @param {string} html
 * @param {string[]} [addAttr]
 * @returns {string}
 */
export function sanitizeHtml(html, addAttr = []) {
	try {
		return sanitize(html, { ADD_ATTR: addAttr });
	} finally {
		clearWindow();
	}
}
