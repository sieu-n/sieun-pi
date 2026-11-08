import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { definitionText } from '../src/lib/definitions.mjs';
import { entryKeys, knownMembers, memberKeys, namedEntries } from '../src/lib/stale-rules.mjs';
import { pageRepo } from './page-repo.mjs';
import { engineReports, snapshotTree } from '../scripts/wiki-health.mjs';

// A git repo with wiki pages (page-repo.mjs); stale() runs the stale report on its tip.
function fixture(t, name = 'wiki-stale-') {
	const repo = pageRepo(t, name);
	const stale = () => {
		const root = snapshotTree(path.join(repo.dir, 'apps/llm-wiki/content'), repo.dir);
		t.after(() => rmSync(root, { recursive: true, force: true }));
		return engineReports(root, repo.dir).stale;
	};
	const refsByPage = () => Object.fromEntries(stale().stale.map((row) => [row.path, row.staleRefs]));
	repo.write('apps/llm-wiki/content/index.html', '<h1>Home</h1>\n');
	return { ...repo, stale, refsByPage };
}
const at = (since, modified = since) => ({ modified: `2026-10-20T${modified}:00:00.000Z`, since: `2026-10-20T${since}:00:00.000Z` });

// 2026-10-20: the report read a last_verified day as its end, so a change later on that day never counted.
test('the stale report dates the check and the code by the tip, so a change later on the check day counts', (t) => {
	const w = fixture(t);
	for (const file of ['a.py', 'b.py', 'c.py', 'lib/x.py']) w.write(file, 'x = 1\n');
	w.page('same-day.html', ['a.py'], { verified: '2026-10-20' });
	w.page('older-day.html', ['a.py'], { verified: '2026-10-19' });
	w.page('timed.html', ['b.py']);
	w.page('folder.html', ['lib/']);
	w.page('touched.html', ['c.py'], { verified: '2026-10-20' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	for (const [file, text, when] of [['a.py', 'x = 2\n', '02:00'], ['b.py', 'x = 2\n', '02:30'], ['lib/x.py', 'x = 2\n', '04:00'], ['lib/x.py', 'x = 3\n', '05:00']]) {
		w.write(file, text);
		w.commit(`2026-10-20T${when}:00Z`, file);
	}
	const later = new Date('2026-10-21T00:00:00Z');
	utimesSync(path.join(w.dir, 'c.py'), later, later);

	const stale = w.stale();
	const rows = Object.fromEntries(stale.stale.map((row) => [row.path, row]));
	assert.deepEqual(Object.keys(rows).sort(), ['apps/folder.html', 'apps/older-day.html', 'apps/same-day.html']);
	assert.equal(rows['apps/same-day.html'].verified_at, '2026-10-20T01:00:00.000Z', 'a bare day is dated by the page commit on that day');
	assert.equal(rows['apps/older-day.html'].verified_at, '2026-10-19T23:59:59.000Z', 'a later edit of the page is no check');
	assert.deepEqual(rows['apps/same-day.html'].staleRefs, [{ ref: 'a.py', ...at('02') }]);
	assert.deepEqual(rows['apps/folder.html'].staleRefs, [{ ref: 'lib/', ...at('04', '05') }], 'since is the first change after the check and modified the newest');
	assert.equal(stale.count, 3);
});

// A whole-file ref counts a commit only when it touches a <code> word of the page, a definition it names or a line number.
test('a whole-file ref counts only the commits that touch what the page states', (t) => {
	const w = fixture(t);
	const py = (alpha, beta, factor) =>
		`ALPHA_LIMIT = 5\nBETA_FACTOR = ${factor}\n\n\ndef alpha(x):\n    return x + ${alpha}\n\n\ndef beta(x):\n    return x * ${beta}\n`;
	w.write('s.py', py(1, 2, 3));
	for (const [name, body] of [
		['named', '<p><code>alpha</code> adds up to <code>ALPHA_LIMIT</code>.</p>'],
		['token', '<p>The factor is <code>BETA_FACTOR</code>.</p>'],
		['lines', '<p><code>ALPHA_LIMIT</code> sits at s.py:1.</p>'],
		['plain', '<p>The file adds and multiplies.</p>'],
	])
		w.page(`${name}.html`, ['s.py'], { body });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	for (const [args, when] of [[[1, 9, 3], '04'], [[1, 9, 4], '05'], [[7, 9, 4], '06']]) {
		w.write('s.py', py(...args));
		w.commit(`2026-10-20T${when}:00:00Z`, when);
	}

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/named.html'], [{ ref: 's.py', ...at('06') }], 'edits of beta and BETA_FACTOR touch nothing the page names, and the edit inside alpha does');
	assert.deepEqual(rows['apps/token.html'], [{ ref: 's.py', ...at('05') }], 'a changed line holding BETA_FACTOR touches the page');
	assert.deepEqual(rows['apps/lines.html'], [{ ref: 's.py', ...at('04', '06') }], 'a page that cites a line number counts every edit');
	assert.deepEqual(rows['apps/plain.html'], [{ ref: 's.py', ...at('04', '06') }], 'a page with no distinctive code word counts every edit');
});

// 2026-10-27: the `tasks` of scripts/ci/tasks/*.sh named turbo.json's top-level "tasks" block, so every turbo.json commit touched the page.
test('a path segment in a <code> span names no definition, and a turbo task id names its task', (t) => {
	const w = fixture(t);
	const turbo = ({ guards = [], grafana = [], outputs = ['dist/**'] } = {}) =>
		`${JSON.stringify(
			{
				tasks: {
					'//#ci:guards': { inputs: ['scripts/ci/tasks/guard-tests.sh', ...guards] },
					'//#ci:grafana': { inputs: ['scripts/ci/tasks/grafana.sh', ...grafana] },
					'search#build': { outputs },
				},
			},
			null,
			'\t',
		)}\n`;
	w.write('turbo.json', turbo());
	w.page('guards.html', ['turbo.json'], { body: '<p><code>//#ci:guards</code> runs <code>scripts/ci/tasks/guard-tests.sh</code>.</p>' });
	w.page('build.html', ['turbo.json'], { body: '<p><code>search#build</code> runs <code>scripts/ci/tasks/search-build.sh</code>.</p>' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	for (const [args, when] of [
		[{ grafana: ['scripts/dev/box-run.sh'] }, '04'],
		[{ grafana: ['scripts/dev/box-run.sh'], guards: ['scripts/ci/check-env-policy.mjs'] }, '05'],
		[{ grafana: ['scripts/dev/box-run.sh'], guards: ['scripts/ci/check-env-policy.mjs'], outputs: ['.svelte-kit/output/**'] }, '06'],
	]) {
		w.write('turbo.json', turbo(args));
		w.commit(`2026-10-20T${when}:00:00Z`, when);
	}

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/guards.html'], [{ ref: 'turbo.json', ...at('05') }], 'an //#ci:grafana input touches nothing the page names, and an //#ci:guards input does');
	assert.deepEqual(rows['apps/build.html'], [{ ref: 'turbo.json', ...at('06') }], 'only the search#build edit touches the page');
});

// 2026-10-26: a comment sweep from 23:20Z to 00:18Z read 116 pages as behind code, for commits that only cut comments and docstrings.
test('a comment-only or docstring-only change leaves a page current, unless the page cites line numbers', (t) => {
	const w = fixture(t);
	const py = ({ doc = 'Module doc.', fn = 'Add one.', note = 'cap at ALPHA_LIMIT', add = '1' } = {}) =>
		`"""${doc}"""\nALPHA_LIMIT = 5\n\n\ndef alpha(x):\n    """${fn}"""\n    # ${note}\n    return x + ${add}  # ALPHA_LIMIT bound\n`;
	const ts = ({ note = 'The cap is LIMIT_MAX.', inner = 'LIMIT_MAX', max = 3 } = {}) =>
		`/**\n * ${note}\n */\nexport const cap = {\n\t// ${inner}\n\tmax: ${max}, /* ${inner} */\n\turl: 'https://x.test//LIMIT_MAX',\n};\n`;
	w.write('k.py', py());
	w.write('t.ts', ts());
	for (const [name, ref, body] of [
		['def', 'k.py::alpha', ''],
		['named', 'k.py', '<p>The bound is <code>ALPHA_LIMIT</code>.</p>'],
		['plain', 'k.py', '<p>The file adds.</p>'],
		['lines', 'k.py', '<p><code>ALPHA_LIMIT</code> sits at k.py:2.</p>'],
		['cap', 't.ts::cap', ''],
		['ts', 't.ts', '<p><code>cap.max</code> is <code>LIMIT_MAX</code>.</p>'],
	])
		w.page(`${name}.html`, [ref], { body });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('k.py', py({ doc: 'Module doc,\nnow longer.', note: 'cap at the ALPHA_LIMIT bound' }));
	w.write('t.ts', ts({ note: 'The cap, LIMIT_MAX.', inner: 'LIMIT_MAX, the bound' }));
	w.commit('2026-10-20T04:00:00Z', 'comments only');
	w.write('k.py', py({ doc: 'Module doc,\nnow longer.', fn: 'Add one, up to ALPHA_LIMIT.', note: 'cap at the ALPHA_LIMIT bound' }));
	w.commit('2026-10-20T05:00:00Z', 'docstrings only');
	w.write('k.py', py({ add: 'ALPHA_LIMIT' }));
	w.write('t.ts', ts({ max: 4 }));
	w.commit('2026-10-20T06:00:00Z', 'code and comments');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/def.html'], [{ ref: 'k.py::alpha', ...at('06') }], 'a cut comment or docstring inside alpha is no change to alpha');
	assert.deepEqual(rows['apps/named.html'], [{ ref: 'k.py', ...at('06') }], 'a comment line holding ALPHA_LIMIT does not touch the page');
	assert.deepEqual(rows['apps/plain.html'], [{ ref: 'k.py', ...at('06') }], 'a page with no distinctive code word counts only code changes');
	assert.deepEqual(rows['apps/lines.html'], [{ ref: 'k.py', ...at('04', '06') }], 'a comment cut moves the lines the page cites');
	assert.deepEqual(rows['apps/cap.html'], [{ ref: 't.ts::cap', ...at('06') }]);
	assert.deepEqual(rows['apps/ts.html'], [{ ref: 't.ts', ...at('06') }], 'a // or /* */ comment holding LIMIT_MAX is no code, and an edit inside cap is');
});

// 2026-10-23: a `sieun-pi:<path>::<name>` ref always read missing, and `up_x() { # comment` was no shell definition.
test('a sibling-repo path::name ref and a shell function ref follow their definition', (t) => {
	const w = fixture(t);
	const pi = fixture(t, 'wiki-stale-sibling-pi-');
	const py = (alpha, beta) => `def alpha(x):\n    return x + ${alpha}\n\n\ndef beta(x):\n    return x * ${beta}\n`;
	const sh = (port) => `up_x() { # <port>\n  echo ${port}\n}\n\ndown_x() {\n  echo down\n}\n`;
	w.write('svc.sh', sh(1));
	pi.write('pool/s.py', py(1, 2));
	for (const [name, ref] of [['alpha', 'sieun-pi:pool/s.py::alpha'], ['beta', 'sieun-pi:pool/s.py::beta'], ['gone', 'sieun-pi:pool/s.py::gamma'], ['up', 'svc.sh::up_x'], ['down', 'svc.sh::down_x']])
		w.page(`${name}.html`, [ref]);
	w.init();
	pi.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	pi.commit('2026-10-20T01:00:00Z', 'pool');
	pi.write('pool/s.py', py(1, 3));
	pi.commit('2026-10-20T04:00:00Z', 'beta');
	w.write('svc.sh', sh(2));
	w.commit('2026-10-20T05:00:00Z', 'up_x');

	const saved = process.env.SIEUN_PI_REPO;
	t.after(() => (saved === undefined ? delete process.env.SIEUN_PI_REPO : (process.env.SIEUN_PI_REPO = saved)));
	process.env.SIEUN_PI_REPO = pi.dir;
	const rows = w.refsByPage();
	assert.deepEqual(Object.keys(rows).sort(), ['apps/beta.html', 'apps/gone.html', 'apps/up.html']);
	assert.deepEqual(rows['apps/beta.html'], [{ ref: 'sieun-pi:pool/s.py::beta', ...at('04') }]);
	assert.deepEqual(rows['apps/gone.html'], [{ ref: 'sieun-pi:pool/s.py::gamma', modified: 'missing — ref no longer exists' }]);
	assert.deepEqual(rows['apps/up.html'], [{ ref: 'svc.sh::up_x', ...at('05') }], 'a shell function with a comment after its brace is a definition, and an edit inside it counts');
});

// 2026-11-08: sieun-pi d0799f3f changed only the header comment of scripts/wiki-storage/backup.mjs, and the report dated a whole-file
// sibling ref by `git log -1`, so two pages that cite that file read as behind it.
test('a sibling-repo whole-file or folder ref counts only the code changes that touch what the page states', (t) => {
	const w = fixture(t);
	const pi = fixture(t, 'wiki-stale-sibling-pi-');
	const py = ({ note = 'Adds one.', alpha = 1, beta = 2 } = {}) =>
		`# ${note}\nALPHA_LIMIT = 5\n\n\ndef alpha(x):\n    return x + ${alpha}\n\n\ndef beta(x):\n    return x * ${beta}\n`;
	pi.write('pool/s.py', py());
	for (const [name, ref] of [['file', 'sieun-pi:pool/s.py'], ['folder', 'sieun-pi:pool/'], ['gone', 'sieun-pi:pool/gone.py']])
		w.page(`${name}.html`, [ref], { body: '<p><code>alpha</code> adds up to <code>ALPHA_LIMIT</code>.</p>' });
	w.init();
	pi.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	pi.commit('2026-10-20T01:00:00Z', 'pool');
	pi.write('pool/s.py', py({ note: 'Adds one, up to ALPHA_LIMIT.' }));
	pi.commit('2026-10-20T04:00:00Z', 'comment only');
	pi.write('pool/s.py', py({ note: 'Adds one, up to ALPHA_LIMIT.', beta: 3 }));
	pi.commit('2026-10-20T05:00:00Z', 'beta, which the page does not name');
	pi.write('pool/s.py', py({ note: 'Adds one, up to ALPHA_LIMIT.', alpha: 2, beta: 3 }));
	pi.commit('2026-10-20T06:00:00Z', 'alpha');

	const saved = process.env.SIEUN_PI_REPO;
	t.after(() => (saved === undefined ? delete process.env.SIEUN_PI_REPO : (process.env.SIEUN_PI_REPO = saved)));
	process.env.SIEUN_PI_REPO = pi.dir;
	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/file.html'], [{ ref: 'sieun-pi:pool/s.py', ...at('06') }], 'a comment edit and an edit of beta touch nothing the page states');
	assert.deepEqual(rows['apps/folder.html'], [{ ref: 'sieun-pi:pool/', ...at('06') }]);
	assert.deepEqual(rows['apps/gone.html'], [{ ref: 'sieun-pi:pool/gone.py', modified: 'missing — ref no longer exists' }]);
});

// 2026-11-04: the auto-sns-agent tip held addbbf5329 (13:12:35Z) above afc3ff7332 (13:13:02Z), and `git log --since=13:12:40Z` stopped
// at the first. The report's walk back to the oldest check day and its walk of a sibling repo's definition each stopped that way.
test('the stale report finds a commit after the check below a commit dated before it', (t) => {
	const w = fixture(t);
	const pi = fixture(t, 'wiki-stale-sibling-pi-');
	const py = (alpha) => `def alpha(x):\n    return x + ${alpha}\n`;
	w.write('a.py', 'x = 1\n');
	w.write('b.py', 'x = 1\n');
	pi.write('pool/s.py', py(1));
	pi.write('pool/t.py', 'y = 1\n');
	w.page('day.html', ['a.py'], { verified: '2026-10-20T00:30Z' });
	w.page('sibling.html', ['sieun-pi:pool/s.py::alpha'], { verified: '2026-10-20T03:30Z' });
	w.init();
	pi.init();
	w.commit('2026-10-19T12:00:00Z', 'pages');
	w.write('a.py', 'x = 2\n');
	w.commit('2026-10-20T01:00:00Z', 'a.py');
	w.write('b.py', 'x = 2\n');
	w.commit('2026-10-19T23:00:00Z', 'b.py dated before the oldest check day');
	pi.commit('2026-10-20T01:00:00Z', 'pool');
	pi.write('pool/s.py', py(2));
	pi.commit('2026-10-20T04:00:00Z', 'alpha');
	pi.write('pool/t.py', 'y = 2\n');
	pi.commit('2026-10-20T03:00:00Z', 't.py dated before the check');

	const saved = process.env.SIEUN_PI_REPO;
	t.after(() => (saved === undefined ? delete process.env.SIEUN_PI_REPO : (process.env.SIEUN_PI_REPO = saved)));
	process.env.SIEUN_PI_REPO = pi.dir;
	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/day.html'], [{ ref: 'a.py', ...at('01') }]);
	assert.deepEqual(rows['apps/sibling.html'], [{ ref: 'sieun-pi:pool/s.py::alpha', ...at('04') }]);
});

// 2026-10-25: a ref to a YAML list item keyed by a field, as `vent.yaml::vent-front-door-failing-prod` cites a Grafana alert rule, read missing.
test('a path::name ref to a YAML list item follows only that item', (t) => {
	const w = fixture(t);
	const rules = (stg) =>
		`groups:\n  - name: vent\n    rules:\n      - uid: door-prod\n        for: 0m\n        labels: { env: production }\n\n      - uid: "door-stg"\n        for: ${stg}\n`;
	w.write('alerts.yaml', rules('0m'));
	for (const [name, ref] of [['prod', 'alerts.yaml::door-prod'], ['stg', 'alerts.yaml::door-stg'], ['gone', 'alerts.yaml::door-dev']]) w.page(`${name}.html`, [ref]);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('alerts.yaml', rules('5m'));
	w.commit('2026-10-20T04:00:00Z', 'door-stg');

	const rows = w.refsByPage();
	assert.deepEqual(Object.keys(rows).sort(), ['apps/gone.html', 'apps/stg.html'], 'an edit of the next item is no change to door-prod');
	assert.deepEqual(rows['apps/stg.html'], [{ ref: 'alerts.yaml::door-stg', ...at('04') }]);
	assert.deepEqual(rows['apps/gone.html'], [{ ref: 'alerts.yaml::door-dev', modified: 'missing — ref no longer exists' }]);
});

// 2026-10-28: 6a0b8a728a only reworded a comment in the guest block of apps/infra/ci-server/host-vars.ci02.yml, and
// runners.html read as behind code through its ref host-vars.ci02.yml::guest, because code-text.mjs kept YAML comments.
test('a comment-only change in a cited YAML or TOML block leaves the page current, and a value change counts', (t) => {
	const w = fixture(t);
	const hosts = ({ note = 'heavy keeps 16', vcpus = 16, run = 'echo "#1"' } = {}) =>
		`ci:\n  guest:\n    # ${note}\n    vcpus_by_class: {heavy: ${vcpus}}  # ${note}\n    label: "ci # guest"\n    run: |\n      # ${run}\n      ${run}\n  slots: 24\n`;
	const pyproject = ({ note = 'pinned', line = 100 } = {}) => `[tool.ruff]\n# ${note}\nline-length = ${line} # ${note}\n`;
	w.write('host-vars.yml', hosts());
	w.write('pyproject.toml', pyproject());
	for (const [name, ref, body] of [
		['guest', 'host-vars.yml::guest', ''],
		['hosts', 'host-vars.yml', '<p><code>vcpus_by_class</code> sizes a heavy guest.</p>'],
		['ruff', 'pyproject.toml', '<p><code>line-length</code> is set.</p>'],
	])
		w.page(`${name}.html`, [ref], { body });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('host-vars.yml', hosts({ note: 'heavy keeps 16 vcpus_by_class, measured 10-28' }));
	w.write('pyproject.toml', pyproject({ note: 'pinned line-length' }));
	w.commit('2026-10-20T04:00:00Z', 'comments only');
	w.write('host-vars.yml', hosts({ vcpus: 8 }));
	w.write('pyproject.toml', pyproject({ line: 120 }));
	w.commit('2026-10-20T05:00:00Z', 'values');
	w.write('host-vars.yml', hosts({ vcpus: 8, run: 'echo "#2"' }));
	w.commit('2026-10-20T06:00:00Z', 'block scalar body');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/guest.html'], [{ ref: 'host-vars.yml::guest', ...at('05', '06') }], 'a # line in a block scalar body is code');
	assert.deepEqual(rows['apps/hosts.html'], [{ ref: 'host-vars.yml', ...at('05') }], 'a comment holding vcpus_by_class is no code');
	assert.deepEqual(rows['apps/ruff.html'], [{ ref: 'pyproject.toml', ...at('05') }]);
});

// 2026-10-29: f942d53743 added a Caddyfile comment that holds POST, a <code> word of telemetry-map.html, and the page read as
// behind code, because code-text.mjs kept Caddyfile, Dockerfile, systemd unit and .env comments.
test('a comment-only change in a cited Caddyfile, Dockerfile, systemd unit or .env file leaves the page current', (t) => {
	const w = fixture(t);
	const files = ({ note = 'routes', port = 8080 } = {}) => ({
		'staging.Caddyfile': `staging.example {\n\t# ${note} POST\n\t@ops path /ops/* # ${note} POST\n\trespond "POST # kept" 200\n\treverse_proxy http://crawler:${port}/#POST\n}\n`,
		Dockerfile: `# syntax=docker/dockerfile:1\n# ${note} NODE_ENV\nFROM node:24\nENV NODE_ENV=production PORT=${port}\n`,
		'box-stop.timer': `[Timer]\n; ${note} OnCalendar\n# ${note} OnCalendar\nOnCalendar=*:0/${port}\n`,
		'.env.example': `# ${note} CRAWLER_PORT\nCRAWLER_PORT=${port} # ${note} CRAWLER_PORT\n`,
	});
	const words = { 'staging.Caddyfile': 'POST', Dockerfile: 'NODE_ENV', 'box-stop.timer': 'OnCalendar', '.env.example': 'CRAWLER_PORT' };
	for (const [file, text] of Object.entries(files())) w.write(file, text);
	for (const [file, word] of Object.entries(words)) w.page(`${word}.html`, [file], { body: `<p><code>${word}</code> is set.</p>` });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	for (const [file, text] of Object.entries(files({ note: 'new routes, see' }))) w.write(file, text);
	w.commit('2026-10-20T04:00:00Z', 'comments only');
	assert.deepEqual(w.refsByPage(), {}, 'a # comment holding the page word is no code');
	for (const [file, text] of Object.entries(files({ port: 9090 }))) w.write(file, text);
	w.commit('2026-10-20T05:00:00Z', 'values');
	const rows = w.refsByPage();
	for (const [file, word] of Object.entries(words)) assert.deepEqual(rows[`apps/${word}.html`], [{ ref: file, ...at('05') }]);
});

// 2026-10-29: enterprise-mock.html cited apps/virev-demo/src/routes/dev/design/charts/+page.svelte, a gitignored file a
// materialize step rewrites, and the engine dated it by mtime, so every materialize flagged the page as changed.
test('a ref git does not track reads as missing even when a gitignored file sits at its path', (t) => {
	const w = fixture(t);
	w.write('.gitignore', 'generated/\n');
	w.write('src/kept.ts', 'export const kept = 1;\n');
	w.page('mock.html', ['generated/page.svelte', 'generated/page.svelte::render', 'src/kept.ts']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('generated/page.svelte', '<script>export function render() {}</script>\n');
	const later = new Date('2026-10-21T00:00:00Z');
	utimesSync(path.join(w.dir, 'generated/page.svelte'), later, later);
	assert.deepEqual(w.refsByPage(), {
		'apps/mock.html': [
			{ ref: 'generated/page.svelte', modified: 'missing — ref no longer exists' },
			{ ref: 'generated/page.svelte::render', modified: 'missing — ref no longer exists' },
		],
	});
});

// 2026-10-25: sieun/dev moved while the report ran, so the log lacked the commit HEAD's text already had, and
// monitor-data-model.html read as behind searchWatchedBrands since an older commit that never changed it.
test('a path::name ref reads one pinned commit while HEAD moves during the report', (t) => {
	const w = fixture(t);
	const py = (alpha, beta) => `def alpha(x):\n    return x + ${alpha}\n\n\ndef beta(x):\n    return x * ${beta}\n`;
	w.write('m.py', py(1, 2));
	w.page('alpha.html', ['m.py::alpha']);
	w.page('beta.html', ['m.py::beta']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('m.py', py(1, 3));
	w.commit('2026-10-20T04:00:00Z', 'beta');
	const git = (...args) => execFileSync('git', args, { cwd: w.dir, encoding: 'utf8' }).trim();
	const pinned = git('rev-parse', 'HEAD');
	w.write('m.py', py(9, 3));
	w.commit('2026-10-20T05:00:00Z', 'alpha');
	const moved = git('rev-parse', 'HEAD');
	git('update-ref', 'HEAD', pinned);

	// A git on PATH that moves HEAD to the alpha commit right after the report's one log read.
	const bin = mkdtempSync(path.join(tmpdir(), 'wiki-stale-git-'));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	const mark = path.join(bin, 'move-once');
	writeFileSync(mark, '');
	const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
	writeFileSync(
		path.join(bin, 'git'),
		`#!/bin/sh\ncase " $* " in *" --format=%ct %H %P "*)\n  if [ -f '${mark}' ]; then\n    out=$('${real}' "$@"); status=$?\n    rm -f '${mark}'\n    '${real}' -C '${w.dir}' update-ref HEAD ${moved}\n    printf '%s\\n' "$out"; exit $status\n  fi;;\nesac\nexec '${real}' "$@"\n`,
		{ mode: 0o755 },
	);
	const saved = process.env.PATH;
	t.after(() => (process.env.PATH = saved));
	process.env.PATH = `${bin}${path.delimiter}${saved}`;

	const rows = w.refsByPage();
	assert.ok(!existsSync(mark), 'the report read its log through the git that moves HEAD');
	assert.equal(git('rev-parse', 'HEAD'), moved, 'HEAD moved during the report');
	assert.deepEqual(Object.keys(rows), ['apps/beta.html'], 'alpha is unchanged at the commit the log was read on');
	assert.deepEqual(rows['apps/beta.html'], [{ ref: 'm.py::beta', ...at('04') }]);
});

// 2026-11-02: one git log over the 1,737 cited paths took 514 s of a 531 s report on us-metal02, so wiki-health hit its 480 s limit.
test('the report logs commits with no pathspec and diffs each commit once across reports', (t) => {
	const w = fixture(t);
	w.write('a.py', 'x = 1\n');
	w.write('b.py', 'y = 1\n');
	w.page('a.html', ['a.py']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('b.py', 'y = 2\n');
	w.commit('2026-10-20T04:00:00Z', 'b');

	const bin = mkdtempSync(path.join(tmpdir(), 'wiki-stale-git-'));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	const calls = path.join(bin, 'calls');
	const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
	writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
	const saved = process.env.PATH;
	t.after(() => (process.env.PATH = saved));
	process.env.PATH = `${bin}${path.delimiter}${saved}`;
	const report = () => {
		writeFileSync(calls, '');
		const rows = w.refsByPage();
		const lines = readFileSync(calls, 'utf8').split('\n');
		return { rows, logs: lines.filter((line) => / log /.test(line)), diffs: lines.filter((line) => / diff-tree /.test(` ${line}`)) };
	};

	const first = report();
	assert.deepEqual(first.rows, {}, 'b.py is no ref of the page');
	assert.ok(first.logs.length && first.logs.every((line) => !/--name-only| -- /.test(line)), first.logs.join('\n'));
	assert.equal(first.diffs.length, 1, 'one diff-tree reads the files of every commit');
	assert.equal(report().diffs.length, 0, 'a report on the same tip diffs no commit again');

	w.write('a.py', 'x = 2\n');
	w.commit('2026-10-20T05:00:00Z', 'a');
	const third = report();
	assert.equal(third.diffs.length, 1, 'a new commit is diffed');
	assert.deepEqual(third.rows, { 'apps/a.html': [{ ref: 'a.py', ...at('05') }] });
});

// 2026-11-04: GET /api/agent/stale ran 570 git processes for 253 pages on every call and took 54 to 80 s, so :5184 answered 502.
test('a report on an unchanged tip reruns no page, and a new commit reruns only the pages citing what it changed', (t) => {
	const w = fixture(t);
	const py = (n) => `def alpha(x):\n    return x + ${n}\n`;
	w.write('a.py', py(1));
	w.write('b.py', py(1));
	w.page('a.html', ['a.py::alpha']);
	w.page('b.html', ['b.py::alpha']);
	w.page('folder.html', ['b.py']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('b.py', py(2));
	w.commit('2026-10-20T04:00:00Z', 'b');

	const bin = mkdtempSync(path.join(tmpdir(), 'wiki-stale-git-'));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	const calls = path.join(bin, 'calls');
	const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
	writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
	const saved = process.env.PATH;
	t.after(() => (process.env.PATH = saved));
	process.env.PATH = `${bin}${path.delimiter}${saved}`;
	// The page reads of the report: the blob reads, a per-ref log or show, and the tree listing at the pinned sha.
	const pageReads = (lines) =>
		lines.filter((line) => /(^| )cat-file |(^| )show (?!-s )| log .* -- |ls-tree -r -z --name-only [0-9a-f]{40} /.test(line));
	const report = () => {
		writeFileSync(calls, '');
		const rows = w.refsByPage();
		return { rows, reads: pageReads(readFileSync(calls, 'utf8').split('\n').filter(Boolean)) };
	};
	const behindB = { 'apps/b.html': [{ ref: 'b.py::alpha', ...at('04') }], 'apps/folder.html': [{ ref: 'b.py', ...at('04') }] };

	const first = report();
	assert.deepEqual(first.rows, behindB);
	assert.ok(first.reads.length > 0, 'the first report reads the pages');
	const second = report();
	assert.deepEqual(second.rows, behindB, 'the kept result is the same report');
	assert.deepEqual(second.reads, [], 'a report on the same tip runs no per-page git read');

	w.write('a.py', py(3));
	w.commit('2026-10-20T05:00:00Z', 'a');
	const third = report();
	assert.deepEqual(third.rows, { 'apps/a.html': [{ ref: 'a.py::alpha', ...at('05') }], ...behindB });
	assert.ok(third.reads.length > 0 && third.reads.every((line) => !/b\.py/.test(line)), third.reads.join('\n'));

	w.page('b.html', ['b.py::alpha'], { verified: '2026-10-20T04:30Z' });
	const fourth = report();
	assert.deepEqual(fourth.rows, { 'apps/a.html': [{ ref: 'a.py::alpha', ...at('05') }], 'apps/folder.html': behindB['apps/folder.html'] }, 'a page whose check moved reruns');
});

// 2026-10-28: the words of a cited path counted one by one, so the `search-admin` of `/api/search-admin/access` touched every
// convex/http.ts line of another search-admin route, and ROUTE_ACCESS refs flagged 21 rechecks in 7 days that fixed no page.
test('a cited path counts only whole, and a path::name route table follows only the routes the page names', (t) => {
	const w = fixture(t);
	const http = (access, other) =>
		`const routes = {\n\t'/api/search-admin/access': handle(${access}),\n\t'/api/search-admin/other': handle(${other}),\n};\n`;
	const table = (a, b) => `export const ROUTES = {\n\t'/api/a': { GET: ${a} },\n\t'/api/b': {\n\t\tGET: ${b},\n\t},\n\t'/api/c': { GET: 0 },\n};\n`;
	w.write('http.ts', http(1, 1));
	w.write('routes.ts', table(1, 1));
	w.page('http.html', ['http.ts'], { body: '<p><code>POST /api/search-admin/access</code> grants access.</p>' });
	w.page('table.html', ['routes.ts::ROUTES'], { body: '<p><code>/api/a</code> is public.</p>' });
	w.page('whole-table.html', ['routes.ts::ROUTES'], { body: '<p>The table holds every route.</p>' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('http.ts', http(1, 2));
	w.write('routes.ts', table(1, 2));
	w.commit('2026-10-20T04:00:00Z', 'other routes');
	w.write('http.ts', http(3, 2));
	w.write('routes.ts', table(3, 2));
	w.commit('2026-10-20T05:00:00Z', 'named routes');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/http.html'], [{ ref: 'http.ts', ...at('05') }], 'an edit of /api/search-admin/other is no change to the page');
	assert.deepEqual(rows['apps/table.html'], [{ ref: 'routes.ts::ROUTES', ...at('05') }], 'an edit of /api/b is no change to /api/a');
	assert.deepEqual(rows['apps/whole-table.html'], [{ ref: 'routes.ts::ROUTES', ...at('04', '05') }], 'a page naming no route follows the table');
});

// 2026-10-29: 29355fa1b8 changed the engage row of the tuple table _PROD_CONTROL_DEFAULTS, and all 5 pages citing the table
// were flagged, while 4 of their rechecks found the page states other rows only and changed only last_verified.
test('a path::name tuple table follows only the quoted keys the page names', (t) => {
	const w = fixture(t);
	const settings = (walks, openings) =>
		`_PROD_CONTROL_DEFAULTS: tuple[tuple[str, int], ...] = (\n    ("meta_ads.advertiser_walks_per_minute", ${walks}),\n    # The engage cap.\n    ("engage.session_openings_per_10min", ${openings}),\n)\n`;
	w.write('settings.py', settings(150, 60));
	const ref = ['settings.py::_PROD_CONTROL_DEFAULTS'];
	w.page('meta-ads.html', ref, { body: '<p><code>meta_ads.advertiser_walks_per_minute</code> is 150 on prod.</p>' });
	w.page('engage.html', ref, { body: '<p><code>engage.session_openings_per_10min = 60</code> on prod.</p>' });
	w.page('whole.html', ref, { body: '<p>The table holds the prod defaults.</p>' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('settings.py', settings(150, 90));
	w.commit('2026-10-20T04:00:00Z', 'engage row');

	const rows = w.refsByPage();
	assert.equal(rows['apps/meta-ads.html'], undefined, 'an edit of the engage row is no change to the meta_ads row');
	assert.deepEqual(rows['apps/engage.html'], [{ ref: ref[0], ...at('04') }]);
	assert.deepEqual(rows['apps/whole.html'], [{ ref: ref[0], ...at('04') }], 'a page naming no key follows the table');
});

// 2026-10-29: 419233997b and 950b9b00e4 edited rows of the array table OPERATION_ROWS in
// apps/api-portal/src/lib/server/operations.ts and flagged the billing, bluesky, linkpages and threads pages, which cite
// other rows. definitionText found no single-line row such as `['crawl.bluesky.profile', ...],`, and entryKeys took the
// 'POST' and path columns of the multi-line rows for keys, so a page that writes `POST /api/crawl/fetch` followed them,
// while a page naming a single-line row's route, such as `/v1/youtube/videos`, followed the whole table.
test('a path::name array table follows only the rows the page names, keyed by their first element', (t) => {
	const ops = (bluesky, dm, structured) =>
		`const OPERATION_ROWS = [\n\t['crawl.bluesky.profile', 'crawl', 'GET', '/v1/crawl/bluesky/profile', ${bluesky}, 'b'],\n\t['instagram.dm.outreach', 'instagram_dm', 'POST', '/v1/instagram/dm/outreach', ${dm}, 'c'],\n\t[\n\t\t'intelligence.contact_complete_structured',\n\t\t'intelligence',\n\t\t'POST',\n\t\t'/v1/intelligence/contact/complete',\n\t\t${structured},\n\t\t'cb',\n\t],\n] as const satisfies readonly OperationRow[];\n`;
	const table = definitionText(ops(500, 20000, 50000), 'OPERATION_ROWS');
	assert.equal(
		definitionText(table, 'crawl.bluesky.profile'),
		"\t['crawl.bluesky.profile', 'crawl', 'GET', '/v1/crawl/bluesky/profile', 500, 'b'],",
	);
	assert.equal(definitionText(table, 'intelligence.contact_complete_structured')?.split('\n').length, 8);
	assert.equal(definitionText(table, 'POST'), null, 'a column value is no row key');
	assert.equal(definitionText(table, '/v1/intelligence/contact/complete'), null, 'a column value is no row key');

	const w = fixture(t);
	w.write('operations.ts', ops(500, 20000, 50000));
	const ref = ['operations.ts::OPERATION_ROWS'];
	w.page('bluesky.html', ref, {
		body: '<p><code>crawl.bluesky.profile</code> costs 500 micros through <code>POST /api/crawl/fetch</code>.</p>',
	});
	w.page('structured.html', ref, { body: '<p><code>intelligence.contact_complete_structured</code> costs 50,000 micros.</p>' });
	w.page('route.html', ref, { body: '<p><code>GET /v1/crawl/bluesky/profile</code> reads one profile.</p>' });
	w.page('multi-route.html', ref, { body: '<p><code>/v1/intelligence/contact/complete</code> takes a POST body.</p>' });
	w.page('whole.html', ref, { body: '<p>The table holds 136 operations.</p>' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('operations.ts', ops(500, 25000, 50000));
	w.commit('2026-10-20T04:00:00Z', 'dm row');
	w.write('operations.ts', ops(500, 25000, 60000));
	w.commit('2026-10-20T05:00:00Z', 'structured row');
	w.write('operations.ts', ops(600, 25000, 60000));
	w.commit('2026-10-20T06:00:00Z', 'bluesky row');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/bluesky.html'], [{ ref: ref[0], ...at('06') }], 'only an edit of the bluesky row changes the page');
	assert.deepEqual(rows['apps/structured.html'], [{ ref: ref[0], ...at('05') }]);
	assert.deepEqual(rows['apps/route.html'], [{ ref: ref[0], ...at('06') }], 'a route names the row that holds it');
	assert.deepEqual(rows['apps/multi-route.html'], [{ ref: ref[0], ...at('05') }]);
	assert.deepEqual(rows['apps/whole.html'], [{ ref: ref[0], ...at('04', '06') }], 'a page naming no row follows the table');
});

// 2026-11-03: domains/architecture/telemetry-map.html cited prod.Caddyfile and staging.Caddyfile whole for their log and
// /devbox/push blocks, because definitionText named no Caddyfile block, so 728073d946 and other route edits elsewhere in
// those files flagged it 5 times in 7 days while the page stated none of them.
test('a path::name Caddyfile ref names a site, snippet or directive block by its head and runs to its close brace', (t) => {
	const caddy = (obs, hdx, comment = '') =>
		`(redact) {\n\trequest>headers>Cookie replace REDACTED\n}\n\n{\n\tservers {\n\t\ttimeouts {\n\t\t\tread_body_idle -1s\n\t\t}\n\t}\n}\n\n# Grafana ${comment}\nobs.virev.ai, grafana.virev.ai {\n\t@browser {\n\t\tnot header Authorization *\n\t}\n\thandle /digest/* {\n\t\tfile_server\n\t}\n\tlog {\n\t\toutput stderr\n\t}\n\treverse_proxy grafana:3000 {\n\t\tlb_try_duration ${obs}s\n\t}\n}\nhdx.virev.ai {\n\tredir https://us-metal01.tail0c093d.ts.net:8443{uri} 302 # hold ${hdx}\n\trespond "a { b" 403\n}\n`;
	const text = caddy(210, 1);
	const site = definitionText(text, 'obs.virev.ai');
	assert.equal(site, definitionText(text, 'grafana.virev.ai'), 'each address of a site line names the site');
	assert.equal(site?.split('\n').length, 14);
	assert.equal(definitionText(text, 'hdx.virev.ai')?.split('\n').length, 4, 'a brace in a quote or after a # is no brace');
	assert.equal(definitionText(text, '(redact)')?.split('\n').length, 3);
	assert.equal(definitionText(text, 'servers')?.split('\n').length, 5);
	assert.equal(definitionText(text, 'handle /digest/*')?.split('\n').length, 3);
	assert.equal(definitionText(text, '/digest/*'), definitionText(text, 'handle /digest/*'));
	assert.equal(definitionText(text, '@browser')?.split('\n').length, 3);
	assert.equal(definitionText(text, 'handle'), null, 'a bare word of a longer head names no block');
	assert.equal(definitionText(text, 'grafana:3000'), definitionText(text, 'reverse_proxy grafana:3000'));

	const w = fixture(t);
	w.write('obs.Caddyfile', caddy(210, 1));
	w.page('obs.html', ['obs.Caddyfile::obs.virev.ai'], { body: '<p>Caddy holds a call to Grafana for 210 s.</p>' });
	w.page('hdx.html', ['obs.Caddyfile::hdx.virev.ai'], { body: '<p>A browser on hdx goes to the tailnet.</p>' });
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('obs.Caddyfile', caddy(210, 2, 'board opens'));
	w.commit('2026-10-20T04:00:00Z', 'hdx comment and a comment above obs');
	w.write('obs.Caddyfile', caddy(240, 2, 'board opens'));
	w.commit('2026-10-20T05:00:00Z', 'obs hold');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/obs.html'], [{ ref: 'obs.Caddyfile::obs.virev.ai', ...at('05') }], 'an edit of another site is no change');
	assert.equal(rows['apps/hdx.html'], undefined, 'a comment edit in the site is no change');
});

// 2026-10-30: 506e664d4f dropped two rows of the object-row table CASCADE_TABLES in convex/search/orgCascade.ts, and
// apps/search/onboarding-orgs.html, which names other rows, was flagged; its recheck changed only last_verified.
test('a path::name table of object rows follows only the rows whose quoted words the page names', (t) => {
	const cascade = (rows) => `export const CASCADE_TABLES: readonly CascadeEntry[] = [\n${rows.map((row) => `\t${row},`).join('\n')}\n];\n`;
	const carry = "{ table: 'searchCampaignPoolCarry', largeRows: true }";
	const base = ["{ table: 'searchContactFindRequests' }", "{ table: 'searchConversations' }", carry];
	const page = '<p>The walk starts at <code>searchContactFindRequests</code> and reads <code>searchCampaignPoolCarry</code> rows one at a time.</p>';
	const was = definitionText(cascade(base), 'CASCADE_TABLES');
	const keys = entryKeys(page, was);
	assert.deepEqual(keys, ['searchContactFindRequests', 'searchCampaignPoolCarry']);
	const dropped = definitionText(cascade(base.filter((row) => !row.includes('searchConversations'))), 'CASCADE_TABLES');
	assert.equal(namedEntries(dropped, keys), namedEntries(was, keys), 'a row the page does not name is no change');
	const edited = definitionText(cascade(base.map((row) => (row === carry ? "{ table: 'searchCampaignPoolCarry' }" : row))), 'CASCADE_TABLES');
	assert.notEqual(namedEntries(edited, keys), namedEntries(was, keys), 'an edit of a named row is a change');
});

// 2026-10-31: dc9b5aca13 added the defaulted field connect_floor to the dataclass Fingerprint in packages/sirocco/src/sirocco/surfaces.py,
// which flagged all 5 pages citing it, and all 5 rechecks changed only last_verified.
test('a path::name class follows all but a field added with a default that the page does not name', () => {
	const fingerprint = (extra, timeout = '30.0') =>
		`class Fingerprint:\n    headers: Mapping[str, str]\n    verify_tls: bool\n    timeout_s: float = ${timeout}\n${extra}    def __post_init__(self) -> None:\n        if self.timeout_s <= 0:\n            raise ValueError("timeout_s must be positive")`;
	const was = fingerprint('');
	const page = '<p>A <code>Fingerprint</code> holds <code>headers</code> and <code>verify_tls</code>.</p>';
	const keys = memberKeys(page, was);
	const follow = (definition, names = keys) => knownMembers(definition, names);
	const floor = fingerprint('    connect_floor: float | None = None\n');
	assert.equal(follow(floor), follow(was), 'a defaulted field the page does not name is no change');
	const named = memberKeys(`${page}<p><code>connect_floor</code> sets the floor.</p>`, was);
	assert.notEqual(follow(floor, named), follow(was, named), 'a defaulted field the page names is a change');
	assert.notEqual(follow(fingerprint('    connect_floor: float | None\n')), follow(was), 'a field with no default is a change');
	assert.notEqual(follow(fingerprint('    def warm(self) -> None:\n        pass\n')), follow(was), 'an added method is a change');
	assert.notEqual(follow(fingerprint('', '20.0')), follow(was), 'an edit of a field the page does not name is a change');
	assert.deepEqual(memberKeys('<p>A <code>Fingerprint</code> holds <code>headers</code>.</p>', was), [], 'a page naming one member follows the class');
	assert.deepEqual(memberKeys(page, 'def fingerprint(x):\n    return x'), [], 'a function is no class');
});

// 2026-10-28: a ref could not name a route key or a Markdown section, so writers kept convex/http.ts and the runbooks whole.
test('a path::name ref names a route key or a Markdown heading', (t) => {
	const w = fixture(t);
	const http = (a, b) => `secretRoutes(http, {\n\t'/api/a': handle(${a}),\n\t'/api/b': handle(${b}),\n});\n`;
	const readme = (deploy, keeper) => `# Box\n\n## Deploys go through CI\n\n${deploy}\n\n### Gates\n\nGate text.\n\n## Crawler keeper\n\n${keeper}\n`;
	w.write('http.ts', http(1, 1));
	w.write('README.md', readme('Deploy text.', 'Keeper text.'));
	w.page('route.html', ['http.ts::/api/a']);
	w.page('section.html', ['README.md::Deploys go through CI']);
	w.page('gone.html', ['README.md::Upgrade']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('http.ts', http(1, 2));
	w.write('README.md', readme('Deploy text.', 'Keeper text, edited.'));
	w.commit('2026-10-20T04:00:00Z', 'elsewhere');
	w.write('http.ts', http(3, 2));
	w.write('README.md', readme('Deploy text, edited.', 'Keeper text, edited.'));
	w.commit('2026-10-20T05:00:00Z', 'cited');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/route.html'], [{ ref: 'http.ts::/api/a', ...at('05') }]);
	assert.deepEqual(rows['apps/section.html'], [{ ref: 'README.md::Deploys go through CI', ...at('05') }]);
	assert.deepEqual(rows['apps/gone.html'], [{ ref: 'README.md::Upgrade', modified: 'missing — ref no longer exists' }]);
});

// 2026-10-28: 2a8c77c496 added a local `const refresh` inside storeCounts, and the ref to the exported refresh action went stale.
test('a path::name ref follows the top-level definition, not a local of the same name', (t) => {
	const w = fixture(t);
	const code = (local, action) =>
		`export const storeCounts = mutation(() => {\n\tconst refresh = read(${local});\n});\n\nexport const refresh = action(() => {\n\treturn ${action};\n});\n`;
	w.write('refresh.ts', code(1, 1));
	w.page('refresh.html', ['refresh.ts::refresh']);
	w.page('store.html', ['refresh.ts::storeCounts']);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('refresh.ts', code(2, 1));
	w.commit('2026-10-20T04:00:00Z', 'local');
	w.write('refresh.ts', code(2, 2));
	w.commit('2026-10-20T05:00:00Z', 'action');

	const rows = w.refsByPage();
	assert.deepEqual(rows['apps/refresh.html'], [{ ref: 'refresh.ts::refresh', ...at('05') }], 'the local edit is no change to the action');
	assert.deepEqual(rows['apps/store.html'], [{ ref: 'refresh.ts::storeCounts', ...at('04') }]);
});

// 2026-10-29: a commit that updated a page with its code was dated after the page's minute last_verified, so the page
// read as behind that commit; 109 of the 1,557 page flags in the 7 days to 2026-10-29 20:14Z came from such a commit.
test('a commit that changes cited code and the page together is the page check of that code', (t) => {
	const w = fixture(t);
	w.write('a.py', 'A = 1\n');
	w.write('b.py', 'def f():\n    return 1\n');
	w.write('lib/x.py', 'X = 1\n');
	const refs = ['a.py', 'b.py::f', 'lib/'];
	w.page('updated.html', refs, { body: '<p>A is 1.</p>' });
	w.page('other.html', refs);
	w.init();
	w.commit('2026-10-20T01:00:00Z', 'pages');
	w.write('a.py', 'A = 2\n');
	w.write('b.py', 'def f():\n    return 2\n');
	w.write('lib/x.py', 'X = 2\n');
	w.page('updated.html', refs, { body: '<p>A is 2.</p>' });
	w.commit('2026-10-20T04:00:00Z', 'code with its page');

	let rows = w.refsByPage();
	assert.equal(rows['apps/updated.html'], undefined, 'the page changed with its code');
	assert.deepEqual(rows['apps/other.html'], refs.map((ref) => ({ ref, ...at('04') })));

	w.write('a.py', 'A = 3\n');
	w.commit('2026-10-20T05:00:00Z', 'code alone');
	rows = w.refsByPage();
	assert.deepEqual(rows['apps/updated.html'], [{ ref: 'a.py', ...at('05') }], 'a later code commit without the page counts');
});

// 2026-10-30: db8e5529c5 (02:24:16Z) changed code apps/convex/schema.html cites and 5c9e190769 (02:24:44Z) wrote the page with
// last_verified 02:24Z, and the report read the page as behind the code it had just described.
test('a last_verified time to the minute covers that whole minute', (t) => {
	const w = fixture(t);
	w.write('a.py', 'A = 1\n');
	w.page('same-minute.html', ['a.py'], { verified: '2026-10-20T01:00Z' });
	w.page('next-minute.html', ['a.py'], { verified: '2026-10-20T01:00Z' });
	w.page('seconds.html', ['a.py'], { verified: '2026-10-20T01:00:10Z' });
	w.init();
	w.commit('2026-10-20T00:30:00Z', 'pages');
	w.write('a.py', 'A = 2\n');
	w.commit('2026-10-20T01:00:30Z', 'code in the minute of the check');

	let rows = w.refsByPage();
	assert.equal(rows['apps/same-minute.html'], undefined, 'a change inside the checked minute is covered');
	assert.deepEqual(rows['apps/seconds.html'], [{ ref: 'a.py', modified: '2026-10-20T01:00:30.000Z', since: '2026-10-20T01:00:30.000Z' }], 'a time with seconds is the check itself');

	w.write('a.py', 'A = 3\n');
	w.commit('2026-10-20T01:01:00Z', 'code a minute later');
	rows = w.refsByPage();
	assert.deepEqual(rows['apps/next-minute.html'], [{ ref: 'a.py', modified: '2026-10-20T01:01:00.000Z', since: '2026-10-20T01:01:00.000Z' }], 'the next minute counts');
});
