/**
 * changeStats counts the lines a shortest line diff adds and removes. On 2026-11-04 apps/llm-wiki/index.html v59 logged
 * 577 added and 560 removed for about 20 changed lines, because the count took every line between the first and the
 * last change.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server/wiki-write.ts', import.meta.url));
// wiki-write.ts has a parameter property that node's type stripping refuses, so the child loads it through tsx.
const TSX = import.meta.resolve('tsx');
const STATS = `
const [engine, cases] = process.argv.slice(1);
const { changeStats } = await import(engine);
process.stdout.write(JSON.stringify(JSON.parse(cases).map(([a, b]) => changeStats(a, b))));
process.exit(0);
`;

function stats(...cases) {
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', STATS, ENGINE, JSON.stringify(cases)], {
		encoding: 'utf8',
		env: { ...process.env, WIKI_CONFIG: '/nonexistent/wiki-test-no-config.json' },
	});
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout).map(({ linesAdded, linesRemoved }) => [linesAdded, linesRemoved]);
}

// The v59 shape: a 580-line page whose writer changed 3 lines near the top and added 17 near the bottom.
const lines = Array.from({ length: 580 }, (_, i) => `<li>Line ${i} of the system spec.</li>`);
const after = [...lines];
for (const i of [3, 4, 5]) after[i] = `<li>Line ${i}, rechecked.</li>`;
after.splice(575, 0, ...Array.from({ length: 17 }, (_, i) => `<li>New fact ${i}.</li>`));

test('an edit near each end of a page counts only the changed lines', () => {
	assert.deepEqual(stats([lines.join('\n'), after.join('\n')]), [[20, 3]]);
});

test('a pure insert, a pure delete, a full swap and no change count as a line diff does', () => {
	assert.deepEqual(
		stats(['a\nb\nc', 'a\nx\nb\nc'], ['a\nb\nc', 'a\nc'], ['a\nb', 'c\nd\ne'], ['a\nb', 'a\nb'], ['', 'a']),
		[
			[1, 0],
			[0, 1],
			[3, 2],
			[0, 0],
			[1, 1],
		],
	);
});
