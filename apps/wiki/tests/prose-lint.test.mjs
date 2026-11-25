/** Prose lint fails drafts the owner rejected and passes the 메르-style page he accepted and a short one like it. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLintedPath, lintHtml, parsePage, ratchet, savedLintAnswer } from '../src/lib/prose-lint.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`fixtures/prose-lint/${name}`, import.meta.url)), 'utf8');
/** Error rule ids for a snippet. */
const errors = (html) =>
	lintHtml(html)
		.findings.filter((f) => f.severity === 'error')
		.map((f) => f.rule);

test('the rejected gateway-v2 draft fails on structure rules', () => {
	const { counts } = lintHtml(fixture('bad-gateway-v2.html'));
	const ids = Object.keys(counts.byRule).filter((id) => counts.byRule[id].errors > 0);
	assert.ok(ids.includes('em-dash') || ids.includes('label-opener'), ids.join(', '));
	for (const id of ['doc-paragraph', 'bold-overuse', 'table-wall'])
		assert.ok(ids.includes(id), `${id} missing: ${ids.join(', ')}`);
	assert.ok(counts.errors >= 20, `only ${counts.errors} errors`);
});

// The owner rejected this prose rewrite on 2026-10-10, called the numbered-line form unreadable on 2026-11-24
// (#dev-crawler p19, c235, c243), and called paragraphs of 3 to 5 sentences "blocks of text" on 2026-11-25 (c247), so
// its paragraphs of 3 and 4 sentences fail too, as does its prose before any diagram.
test('the prose-paragraph gateway-v2 rewrite fails on its paragraphs, its lead and its missing diagram', () => {
	const { counts } = lintHtml(fixture('bad-gateway-v2-prose.html'));
	const ids = Object.keys(counts.byRule).filter((id) => counts.byRule[id].errors > 0).sort();
	assert.deepEqual(ids, ['doc-paragraph', 'lead-visual', 'visuals'], JSON.stringify(counts.byRule));
});

test('a prose wall with no diagram fails on visuals, paragraphs and lead, and no rule asks for numbered lines', () => {
	const ids = [...new Set(errors(fixture('bad-prose-wall-no-diagram.html')))].sort();
	assert.deepEqual(ids, ['doc-paragraph', 'lead-visual', 'visuals']);
	assert.ok(!ids.includes('paragraph-share'));
});

// The 2026-10 메르-style pages open with numbered lines before their first diagram, which lead-visual refuses (c247),
// and every other rule passes them.
test('the 메르-style gateway-v2 page fails only on its lead, which holds numbered lines before any diagram', () => {
	const html = fixture('good-gateway-v2-mer.html');
	const page = parsePage(html);
	assert.ok(page.units.filter((u) => u.numbered).length >= 100, 'about 112 numbered lines');
	assert.ok(page.visuals.length >= 10, 'about 13 diagrams and images');
	const { findings, counts } = lintHtml(html);
	assert.deepEqual(Object.keys(counts.byRule), ['lead-visual'], JSON.stringify(findings, null, 2));
	assert.equal(counts.errors + counts.warns, 1);
});

test('the numbered-line fixture fails only on its lead', () => {
	const { findings, counts } = lintHtml(fixture('good-mer.html'));
	assert.deepEqual(Object.keys(counts.byRule), ['lead-visual'], JSON.stringify(findings, null, 2));
	assert.equal(counts.errors + counts.warns, 1);
});

// Owner, 2026-11-25 (#dev-api-portal p33, msg mwwkczkq, c247; p35, msg mwwkdhwy, c248), on this page as it stood:
// "slop slop slop slop blocks of text" and "api-portal.yaml:141 이따구로 쓰면 아무것도 모른다니까?????".
test('the API portal page the owner called blocks of text fails on paragraphs, path:line refs and its lead', () => {
	const { findings, counts } = lintHtml(fixture('bad-api-portal-blocks.html'), { now: Date.UTC(2026, 10, 25, 20) });
	const by = (rule) => counts.byRule[rule] ?? { errors: 0, warns: 0 };
	assert.equal(by('doc-paragraph').errors, 10, JSON.stringify(counts.byRule));
	assert.equal(by('line-ref-in-prose').errors, 14);
	assert.equal(by('ref-in-prose').warns, 5);
	assert.equal(by('lead-visual').errors, 1);
	assert.ok(findings.some((f) => f.rule === 'line-ref-in-prose' && f.excerpt.startsWith('"api-portal.yaml:141"')));
	assert.ok(
		findings.some((f) => f.rule === 'line-ref-in-prose' && f.excerpt.startsWith('"apps/api-portal/src/routes/(marketing)/+page.svelte:29-33"')),
		'a path with parentheses stays whole',
	);
});

test('the onboarding fixture, diagram first with short paragraphs and refs in a table, has zero findings', () => {
	const html = fixture('good-onboarding.html');
	for (const path of [undefined, 'domains/bakery/kitchen-tickets.html']) {
		const { findings } = lintHtml(html, { path, now: Date.UTC(2026, 10, 25, 20) });
		assert.deepEqual(findings, [], path);
	}
});

const doc = (body) => `<!--wiki {"title":"Tickets","description":"tickets"} -->\n<h1>Tickets</h1>\n${body}`;
const DIAGRAM = '<pre class="mermaid">flowchart LR\n  a("relay") --> b("printer")</pre>\n';
const rules = (html, severity) =>
	lintHtml(html)
		.findings.filter((f) => f.severity === severity)
		.map((f) => f.rule);

test('doc-paragraph allows 2 short sentences and refuses a third or a paragraph over 50 words', () => {
	const two = 'The relay prints each ticket. A failed ticket tries again after 30 s.';
	assert.deepEqual(rules(doc(`${DIAGRAM}<p>${two}</p>`), 'error'), []);
	assert.deepEqual(rules(doc(`${DIAGRAM}<p>${two} The shop sees a stuck ticket in red.</p>`), 'error'), ['doc-paragraph']);
	const long = `The relay prints ${Array.from({ length: 50 }, (_, i) => `t${i}`).join(' ')}.`;
	assert.deepEqual(rules(doc(`${DIAGRAM}<p>${long}</p>`), 'error'), ['doc-paragraph']);
});

test('a path:line in running prose is an error, and in a table cell or a details fold it passes (c248)', () => {
	const line = '<code>relay/retry.py:40</code>';
	assert.deepEqual(rules(doc(`${DIAGRAM}<p>The retry rule waits 30 s (${line}).</p>`), 'error'), ['line-ref-in-prose']);
	assert.deepEqual(rules(doc(`${DIAGRAM}<ul><li>The retry rule waits 30 s (${line}).</li></ul>`), 'error'), ['line-ref-in-prose']);
	assert.deepEqual(rules(doc(`${DIAGRAM}<p>The retry rule waits 30 s at relay/retry.py:40-52 today.</p>`), 'error'), ['line-ref-in-prose']);
	assert.deepEqual(rules(doc(`${DIAGRAM}<table><tr><td>the retry rule</td><td>${line}</td></tr></table>`), 'error'), []);
	assert.deepEqual(rules(doc(`${DIAGRAM}<details><summary>Refs</summary><p>The retry rule is ${line}.</p></details>`), 'error'), []);
	assert.deepEqual(
		rules(doc(`${DIAGRAM}<p>The site answers on <code>https://orders.example:8443/api</code> and <code>orders.example:8443</code>.</p>`), 'error'),
		[],
		'a URL or a host and port is no line ref',
	);
});

test('a file path, commit id or message id in a paragraph is a warning, and Node.js or a bare number is not', () => {
	const warned = (p) => rules(doc(`${DIAGRAM}<p>${p}</p>`), 'warn').filter((r) => r === 'ref-in-prose').length;
	assert.equal(warned('The relay lives in <code>relay/main.py</code>.'), 1);
	assert.equal(warned('The fix landed in <code>4c6056652f</code>.'), 1);
	assert.equal(warned('The owner asked for it (msg mwwkczkq).'), 1);
	assert.equal(warned('The relay runs on Node.js and prints 1234567 tickets a year.'), 0);
	assert.equal(warned('The relay reads <code>tickets</code> in order.'), 0);
	const refsList = doc(`${DIAGRAM}<ul><li>The relay lives in <code>relay/main.py</code>.</li></ul>`);
	assert.deepEqual(rules(refsList, 'warn'), [], 'a refs list may hold paths');
});

test('lead-visual wants the first diagram or table right after the title and one lead paragraph', () => {
	const lead = '<p>This page is for a new teammate on the bakery orders.</p>\n';
	const point = '<p>Each shop runs its own relay.</p>\n';
	const err = (body) => rules(doc(body), 'error');
	assert.deepEqual(err(`${lead}${DIAGRAM}`), []);
	assert.deepEqual(err(`<wiki-tldr><ul><li>The relay prints each ticket.</li></ul></wiki-tldr>\n${DIAGRAM}`), []);
	assert.deepEqual(err(`${lead}<h2>Where it runs</h2>\n${point}${DIAGRAM}`), [], 'one short paragraph may state the point');
	assert.deepEqual(err(`${lead}${point}${point}${DIAGRAM}`), ['lead-visual']);
	assert.deepEqual(err(`${lead}<h2>Where it runs</h2>\n<ul><li>The relay prints each ticket.</li></ul>\n${DIAGRAM}`), ['lead-visual']);
	assert.deepEqual(err(`${lead}${point}`), [], 'a short page with no diagram or table passes');
	const words = Array.from({ length: 25 }, () => point.replace('.', ' and prints every ticket from its own queue.')).join('');
	assert.deepEqual(err(`${lead}${words}`).filter((r) => r === 'lead-visual'), ['lead-visual']);
	const hub = `<ul>${Array.from({ length: 4 }, (_, i) => `<li><a href="p${i}.html">Page ${i}</a></li>`).join('')}</ul>${DIAGRAM}`;
	assert.deepEqual(err(`${lead}${hub}`), [], 'a hub of links is exempt');
});

test('the ratchet keeps an old page with blocks of text editable, refuses a new one, and passes a write that fixes it', () => {
	const block = '<p>The relay prints each ticket. It tries again after 30 s. The shop sees a stuck ticket in red.</p>\n';
	const old = doc(`<p>This page is for a new teammate.</p>\n${block}${block}${DIAGRAM}`);
	assert.equal(ratchet(null, old).ok, false, 'a new page with blocks of text is refused');
	assert.equal(ratchet(old, old.replace('new teammate', 'new baker')).ok, true, 'an edit that adds no error saves');
	const fixed = doc(`<p>This page is for a new teammate.</p>\n${DIAGRAM}<p>The relay prints each ticket. It tries again after 30 s.</p>\n`);
	const write = ratchet(old, fixed);
	assert.equal(write.ok, true, JSON.stringify(write.grown));
	assert.equal(write.after.errors, 0);
	const worse = old.replace('It tries again after 30 s.', 'It tries again after 30 s (<code>relay/retry.py:40</code>).');
	assert.deepEqual(Object.keys(ratchet(old, worse).grown), ['line-ref-in-prose']);
});

// A page written at 15:30Z with the owner's KST day as its date sat out of git for 7 batch runs (2026-10-28).
const WRITE = Date.UTC(2026, 9, 28, 15, 30);
const page = (updated, line) =>
	`<!--wiki\n{"title": "LinkedIn fields", "date": "2026-10-18", "updated": "${updated}", "status": "current"}\n-->\n` +
	`<h1>LinkedIn fields</h1>\n<ol>\n\t<li>${line}</li>\n</ol>\n`;
const dbaf = page('2026-10-29', 'Convex stores no LinkedIn field, because the rule tag code that read post images was removed on 2026-10-29.');
const lintAt = (html) =>
	lintHtml(html, { now: WRITE })
		.findings.filter((f) => f.severity === 'error' && f.rule.startsWith('future-'))
		.map((f) => f.rule);

test('a header date or a past event dated after the UTC write day is refused, as dbaf9ad972 wrote them', () => {
	assert.deepEqual(lintAt(dbaf).sort(), ['future-meta-date', 'future-utc-time']);
	assert.deepEqual(lintAt(page('2026-10-28T15:41Z', 'The tag code was removed on 2026-10-28.')), ['future-meta-date']);
	assert.deepEqual(lintAt(page('2026-10-28', 'On 10-29 the job landed the cut.')), ['future-utc-time']);
});

test('the UTC day, a past event on it and a plan day with no past verb pass', () => {
	assert.deepEqual(lintAt(page('2026-10-28T15:30Z', 'The tag code was removed on 2026-10-28.')), []);
	assert.deepEqual(lintAt(page('2026-10-28', 'The ignore expires on 2026-11-30, and the review is scheduled on 11-02.')), []);
	const nextDay = lintHtml(dbaf, { now: Date.UTC(2026, 9, 29, 0, 5) }).findings.filter((f) => f.rule.startsWith('future-'));
	assert.deepEqual(nextDay, [], 'the same text passes once the UTC day reaches it');
});

test('the page API ratchet refuses a write that adds a future date and keeps a page that already held one editable', () => {
	const clean = page('2026-10-28', 'The tag code was removed on 2026-10-28.');
	const added = ratchet(clean, dbaf, { now: WRITE });
	assert.equal(added.ok, false);
	assert.deepEqual(Object.keys(added.grown).sort(), ['future-meta-date', 'future-utc-time']);
	assert.equal(ratchet(dbaf, dbaf.replace('LinkedIn field,', 'LinkedIn field itself,'), { now: WRITE }).ok, true);
});

// On 2026-11-04 32 wiki dream writers ran `prose-lint.mjs apps/search/campaigns.html` and got "no such file", because the
// CLI looked under the checkout instead of the content root.
test('the CLI lints a page by wiki path and --recent from the content root', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'prose-lint-root-'));
	const elsewhere = mkdtempSync(path.join(tmpdir(), 'prose-lint-cwd-'));
	try {
		const bad = '<!--wiki\n{"title": "Campaigns"}\n-->\n<h1>Campaigns</h1>\n<p>The page lists campaigns \u2014 one per row.</p>\n';
		mkdirSync(path.join(root, 'apps/search'), { recursive: true });
		writeFileSync(path.join(root, 'apps/search/campaigns.html'), bad);
		mkdirSync(path.join(root, 'sessions/2026/11/04/0509-dream'), { recursive: true });
		writeFileSync(path.join(root, 'sessions/2026/11/04/0509-dream/notes.html'), bad);
		const cli = fileURLToPath(new URL('../scripts/prose-lint.mjs', import.meta.url));
		const run = (...args) =>
			spawnSync(process.execPath, [cli, '--json', ...args], {
				cwd: elsewhere,
				encoding: 'utf8',
				env: { ...process.env, WIKI_CONTENT_ROOT: root, WIKI_CONFIG: path.join(elsewhere, 'none.json') },
			});
		for (const args of [['apps/search/campaigns.html'], ['--recent', '5']]) {
			const out = run(...args);
			assert.equal(out.status, 1, out.stderr);
			const { results } = JSON.parse(out.stdout);
			assert.equal(results.length, 1, out.stdout);
			assert.ok(results[0].counts.byRule['em-dash']?.errors >= 1, JSON.stringify(results[0].counts));
		}
		assert.equal(run('apps/search/missing.html').status, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

// On 2026-11-23 at 06:40Z two wiki dream writers (domains/architecture/outside-calls/attribution.html v19 to v20,
// apps/crawler-v3/architecture/ops-controls/control-plane.html v41 to v42) linted a clean draft, got the page API's rule 9
// not-landed warning on the write and wrote again, because the CLI's file path never ran notLandedWarnings.
test('the CLI warns on a draft line that says a commit has not landed, as the page API does', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'prose-lint-draft-'));
	try {
		const page = (line) =>
			`<!--wiki {"title":"Draft","description":"draft fixture"} -->\n<h1>Draft</h1>\n<ol>\n<li>${line}</li>\n</ol>\n`;
		writeFileSync(path.join(dir, 'stale.html'), page('<code>abc1234567</code> has not landed on staging.'));
		writeFileSync(path.join(dir, 'clean.html'), page('The retry runs on dev/sieun since <code>abc1234567</code>.'));
		const cli = fileURLToPath(new URL('../scripts/prose-lint.mjs', import.meta.url));
		const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
		const stale = run('--json', 'stale.html');
		assert.equal(stale.status, 0, stale.stderr);
		const [result] = JSON.parse(stale.stdout).results;
		const warned = result.findings.filter((f) => f.rule === 'not-landed');
		assert.equal(warned.length, 1, stale.stdout);
		assert.equal(warned[0].severity, 'warn');
		assert.equal(warned[0].line, 4);
		assert.match(warned[0].fix, /on dev\/sieun since abc1234567/);
		assert.deepEqual(result.counts.byRule['not-landed'], { errors: 0, warns: 1 });
		assert.match(run('stale.html').stdout, /L4 {2}warn {2}not-landed/);
		const clean = run('--json', 'clean.html');
		const [ok] = JSON.parse(clean.stdout).results;
		assert.equal(ok.findings.filter((f) => f.rule === 'not-landed').length, 0, clean.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// On 2026-11-24 three wiki dream writers linted a clean draft in /tmp, got core-length from the page API on the write and
// wrote again (gauges-alerts.html v8 to v9, aws-estate.html v94 to v95 and v96 to v97), because the CLI judged a draft by its
// /tmp path, which never matched the apps/ and domains/ rules.
test('the CLI judges a draft outside the content root by its front matter path or --path, so core-length fires', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'prose-lint-core-'));
	try {
		const body = Array.from({ length: 70 }, () => '<p>The worker reads one row from the queue table and writes it back.</p>').join('\n');
		const page = (meta) =>
			`<!--wiki ${JSON.stringify({ title: 'Queue', description: 'The queue.', ...meta })}-->\n<h1>Queue</h1>\n${body}\n`;
		writeFileSync(path.join(dir, 'declared.html'), page({ path: 'domains/devops/queue.html' }));
		writeFileSync(path.join(dir, 'plain.html'), page({}));
		const cli = fileURLToPath(new URL('../scripts/prose-lint.mjs', import.meta.url));
		const coreLength = (...args) => {
			const out = spawnSync(process.execPath, [cli, '--json', ...args], { cwd: dir, encoding: 'utf8' });
			assert.ok(out.status === 0 || out.status === 1, out.stderr);
			const [result] = JSON.parse(out.stdout).results;
			return result.findings.filter((f) => f.rule === 'core-length').map((f) => f.excerpt);
		};
		assert.deepEqual(coreLength('declared.html'), ['911 words, target 800']);
		assert.deepEqual(coreLength('--path', 'domains/devops/queue.html', 'plain.html'), ['911 words, target 800']);
		assert.deepEqual(coreLength('--path', 'projects/x/queue.html', 'plain.html'), []);
		assert.deepEqual(coreLength('plain.html'), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the lint skips API-managed session and job logs but judges other pages in their folders', () => {
	// 2026-11-21: job logs under agents/<slug>/jobs/ were linted while session logs were skipped.
	assert.equal(isLintedPath('sessions/2026/11/21/0101-x/index.html'), false);
	assert.equal(isLintedPath('agents/km/jobs/2026/11/21/0101-x/index.html'), false);
	assert.equal(isLintedPath('agents/km/jobs/2026/11/21/0101-x/report.html'), true);
	assert.equal(isLintedPath('apps/search/index.html'), true);
});

test('a write the ratchet lets through answers with the warnings it kept, so the writer fixes them without a lint run', () => {
	// On 2026-11-04 wiki-dream writers made 10 extra revisions in 7 days by linting after a 201 that named no warning.
	const long = Array.from({ length: 31 }, (_, i) => `word${i}`).join(' ');
	const html = `<!--wiki {"title":"Lint answer fixture","description":"lint answer fixture"} -->\n<h1>Lint answer fixture</h1>\n<p>The engine saves the page. It then answers with ${long} at the end.</p>\n`;
	const result = ratchet(null, html);
	assert.equal(result.ok, true, JSON.stringify(result.grown));
	const answer = savedLintAnswer(result.findings);
	assert.ok(answer, 'a page with a warning gets a lint answer');
	assert.deepEqual(
		answer.lint.map((f) => [f.rule, f.severity, f.line]),
		[['long-sentence', 'warn', 3]],
	);
	assert.match(answer.lint[0].fix, /Split any sentence/);
	assert.match(answer.warning, /saved with 1 finding\(s\) \(long-sentence 1\)/);
	assert.equal(savedLintAnswer(ratchet(null, html.replace(` ${long}`, '')).findings), null, 'a clean page gets none');
});

// On 2026-11-22 at 03:57Z the page API took apps/crawler-v3/contact-discovery/algorithm.html v66 with a link to a
// verdict.html inside a pi-host job folder and gave the writer no word, and the 05:00Z wiki dream precheck counted it.
test('a curated write that adds a link past a job log is saved with a warning naming the log, and one past a session log is refused', () => {
	const page = 'apps/crawler-v3/contact-discovery/algorithm.html';
	const job = 'agents/contact-finder/jobs/2026/11/22/0835-d6-bench-egress-proof';
	const session = 'sessions/2026/11/22/0835-d6-bench';
	const html = (...hrefs) =>
		`<!--wiki {"title":"Algorithm","description":"algorithm"} -->\n<h1>Algorithm</h1>\n` +
		hrefs.map((href) => `<p>The bench proof is in <a href="${href}">the job</a> here.</p>\n`).join('');
	const before = html(`/page/${job}/index.html`);

	const jobWrite = ratchet(before, html(`/page/${job}/index.html`, `../../../${job}/verdict.html`), { path: page });
	assert.equal(jobWrite.ok, true, JSON.stringify(jobWrite.grown));
	const warned = savedLintAnswer(jobWrite.findings)?.lint.filter((f) => f.rule === 'job-folder-link') ?? [];
	assert.equal(warned.length, 1, JSON.stringify(jobWrite.findings));
	assert.equal(warned[0].severity, 'warn');
	assert.match(warned[0].excerpt, new RegExp(`link its log "${job}/index.html"`));
	assert.match(warned[0].fix, /move the fact you linked into this line or into the curated page that owns it/);

	const sessionWrite = ratchet(before, html(`/page/${job}/index.html`, `/page/${session}/verdict.html`), { path: page });
	assert.equal(sessionWrite.ok, false);
	assert.deepEqual(Object.keys(sessionWrite.grown), ['session-link']);
	assert.match(sessionWrite.newFindings[0].excerpt, new RegExp(`link its log "${session}/index.html"`));

	const logOnly = lintHtml(html(`/page/${job}/index.html`, `/page/${job}`, `/page/${session}/index.html`), { path: page });
	assert.deepEqual(logOnly.findings.filter((f) => /link/.test(f.rule)).map((f) => f.rule), []);
	const old = html(`/page/${session}/verdict.html`);
	assert.equal(ratchet(old, `${old}<p>One more plain line sits here.</p>\n`, { path: page }).ok, true, 'a link the page had is old debt');
});
