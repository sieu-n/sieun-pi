/**
 * Over-cap pages: a whole read returns every byte or names the cap, and a write that is a strict prefix of a stored
 * over-cap page is refused. Fixtures live in a session the test opens and closes itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wikiBase } from './wiki-base.mjs';

let BASE = '';
const CAP = 64 * 1024;

let sessionFolder = '';
let FIXTURE = '';
let GUARD = '';
let serverUp = false;

/**
 * The ticket's own body: 68,513 characters, 68,567 bytes, closing section last. The filler
 * sits in <pre>, which the prose lint gate on writes does not judge.
 */
function ticketSizedPage() {
	const head = [
		'<!--wiki {"title":"Read cap fixture","description":"read cap honesty fixture","updated":"2026-09-08"} -->',
		'<h1>Read cap fixture</h1>',
		`<pre>${'é'.repeat(53)}`,
	].join('\n');
	const tail = ['</pre>', '<h2 id="closing">Closing section (é)</h2>', '<p>TAIL-MARKER-VIR-266</p>'].join('\n');
	const unit = 'filler line for the read cap fixture body\n';
	const want = 68_513;
	let filler = '';
	while (filler.length < want - head.length - tail.length - 2) filler += unit;
	const body = `${head}\n${filler.slice(0, want - head.length - tail.length - 2)}\n${tail}`;
	assert.equal(body.length, want, 'fixture must be exactly the ticket size');
	assert.equal(Buffer.byteLength(body), 68_567, 'fixture must be exactly the ticket byte count');
	return body;
}

/** A page comfortably over the read cap. The filler sits in <pre>, which the prose lint gate on writes does not judge. */
function bigPage(marker) {
	const head =
		'<!--wiki {"title":"Guard fixture","description":"truncation guard fixture","updated":"2026-07-21"} -->\n<h1>Guard fixture</h1>\n<pre>\n';
	const filler = `${'x'.repeat(200)}\n`;
	let body = head;
	while (Buffer.byteLength(body) < CAP + 12_000) body += filler;
	return `${body}${marker}\n</pre>\n`;
}

const post = (body) =>
	fetch(`${BASE}/api/agent/page`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

const getPage = (query) => fetch(`${BASE}/api/agent/page?${query}`);
const raw = (path) => fetch(`${BASE}/raw/${path}`).then((r) => r.text());

/** The page index caches for 5s, so a just-written page 404s for a moment. */
async function waitForIndex(pagePath) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const res = await getPage(`path=${encodeURIComponent(pagePath)}`);
		await res.arrayBuffer();
		if (res.status !== 404) return;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${pagePath} never reached the index`);
}

before(async () => {
	BASE = (await wikiBase()) ?? '';
	serverUp = BASE !== '';
	if (!serverUp) return;
	const res = await fetch(`${BASE}/api/agent/sessions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			// Sessions are keyed hhmm-slug, so a fixed slug collides on same-minute reruns.
			slug: `page-cap-${Date.now().toString(36)}`,
			goal: 'Automated fixture workspace for the page cap test run.',
			apps: ['llm-wiki'],
			tags: ['test-fixture'],
		}),
	});
	const data = await res.json();
	sessionFolder = String(data.path ?? data.id ?? '').replace(/\/index\.html$/, '');
	if (!sessionFolder) throw new Error(`could not open a fixture session: ${JSON.stringify(data).slice(0, 200)}`);
	FIXTURE = `${sessionFolder}/read-cap-fixture.html`;
	GUARD = `${sessionFolder}/truncation-guard-fixture.html`;
	assert.ok((await post({ path: FIXTURE, content: ticketSizedPage() })).ok, 'fixture should be creatable');
	await waitForIndex(FIXTURE);
});

after(async () => {
	if (!serverUp || !sessionFolder) return;
	await fetch(`${BASE}/api/agent/sessions/${sessionFolder}/close`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ outcome: 'automated page cap fixtures', no_durable_knowledge: true }),
	}).catch(() => {});
});

test('a 68,513-character page reads back whole, or fails with the cap named', async (t) => {
	if (!serverUp) return t.skip('llm-wiki dev server unreachable — SKIPPED, not passed');

	const stored = await raw(FIXTURE);
	assert.equal(stored.length, 68_513, 'the write must store every character');

	const res = await getPage(`path=${encodeURIComponent(FIXTURE)}`);
	const body = await res.json();
	if (res.ok) {
		assert.equal(body.content.length, stored.length, 'a 200 must carry every stored character, never a prefix');
		assert.match(body.content, /TAIL-MARKER-VIR-266/);
		return;
	}
	assert.equal(res.status, 413, `a refusal must be 413, got ${res.status}`);
	assert.match(body.error, new RegExp(String(CAP)), 'the error must name the cap in bytes');
	assert.match(body.error, /68567/, 'the error must name what is stored');
	assert.match(body.error, /\/raw\//, 'the error must name where the whole page is');
});

test('a section and a line range past the cap are still readable', async (t) => {
	if (!serverUp) return t.skip('llm-wiki dev server unreachable — SKIPPED, not passed');

	const section = await getPage(`path=${encodeURIComponent(FIXTURE)}&section=closing`);
	assert.ok(section.ok, `section read must succeed, got ${section.status}`);
	const found = await section.json();
	assert.equal(found.found, true, 'the closing section sits past the cap and must be found');
	assert.match(found.content, /TAIL-MARKER-VIR-266/);

	const last = (await raw(FIXTURE)).split('\n').length;
	const lines = await getPage(`path=${encodeURIComponent(FIXTURE)}&lines=${last - 1}-${last}`);
	assert.ok(lines.ok, `line read must succeed, got ${lines.status}`);
	assert.match((await lines.json()).content, /TAIL-MARKER-VIR-266/);
});

test('a strict-prefix write to an over-cap page is refused and leaves it intact; an ordinary edit passes', async (t) => {
	if (!serverUp) return t.skip('llm-wiki dev server unreachable — SKIPPED, not passed');

	const full = bigPage('tail marker that must survive');
	assert.ok((await post({ path: GUARD, content: full })).ok, 'fixture should be creatable');

	const truncated = Buffer.from(full, 'utf8').subarray(0, CAP).toString('utf8');
	const res = await post({ path: GUARD, content: truncated });
	assert.equal(res.status, 409, 'truncating write must be refused');
	const { error } = await res.json();
	assert.match(error, /refusing truncating write/);
	assert.match(error, /\/raw\//, 'must tell the caller where to get the full file');
	const kept = await raw(GUARD);
	assert.ok(Buffer.byteLength(kept) > CAP, 'page must still be complete');
	assert.match(kept, /tail marker that must survive/);

	const edited = await post({ path: GUARD, content: bigPage('tail marker edited') });
	assert.ok(edited.ok, `ordinary edit must be allowed, got ${edited.status}`);
	assert.match(await raw(GUARD), /tail marker edited/);
});

test('rejects a truncating write of a CJK page whose cap splits a multibyte char', async (t) => {
	if (!serverUp) return t.skip('llm-wiki dev server unreachable — SKIPPED, not passed');

	// Hangul filler: 3-byte chars, so the 64 KiB boundary lands mid-character unless
	// the head happens to align. Nudge the head until the capped decode really ends
	// in U+FFFD — the test must PROVE it exercises the split, not hope it does.
	// "lang":"ko" marks the Korean as on purpose, so the english-only prose lint lets the write through.
	let head =
		'<!--wiki {"title":"CJK guard fixture","description":"cjk","updated":"2026-07-22","lang":"ko"} -->\n<h1>한글</h1>\n';
	let full = '';
	let capped = '';
	for (let nudge = 0; nudge < 3; nudge++) {
		full = head;
		while (Buffer.byteLength(full) < CAP + 9_000) full += '한국어페이지내용입니다';
		capped = Buffer.from(full, 'utf8').subarray(0, CAP).toString('utf8');
		if (capped.endsWith('\uFFFD')) break;
		head = 'x' + head;
	}
	assert.ok(capped.endsWith('\uFFFD'), 'fixture must actually split a multibyte char at the cap');

	const CJK = `${sessionFolder}/truncation-guard-cjk-fixture.html`;
	assert.ok((await post({ path: CJK, content: full })).ok, 'CJK fixture should be creatable');
	const res = await post({ path: CJK, content: capped });
	assert.equal(res.status, 409, 'truncating write of a CJK page must be refused despite the U+FFFD tail');
});

test('allows a genuine tail-deletion when the caller opts in', async (t) => {
	if (!serverUp) return t.skip('llm-wiki dev server unreachable — SKIPPED, not passed');

	const full = bigPage('tail marker for opt-out');
	assert.ok((await post({ path: GUARD, content: full })).ok);
	const res = await post({ path: GUARD, content: full.slice(0, full.length - 120), allowTruncate: true });
	assert.ok(res.ok, `allowTruncate must permit a deliberate tail deletion, got ${res.status}`);
});
