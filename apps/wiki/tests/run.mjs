// `npm test` and `npm run test:content` for the wiki engine: a file that imports ./wiki-base.mjs calls a wiki server, so it
// runs under test:content; any other file runs under test.
//
// test reads no wiki config: WIKI_CONFIG names a file that does not exist, so a test that builds its own content root or
// repo never reaches the live content. test:content calls the server at WIKI_BASE, else the live engine on
// http://127.0.0.1:5176/wiki, whose content root its tests write their own session folders into.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const content = process.argv.includes('--content');
const CALLS_SERVER = /from '\.\/wiki-base\.mjs'/;
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const files = (only.length ? only : readdirSync('tests').filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/${name}`))
	.sort()
	.filter((file) => CALLS_SERVER.test(readFileSync(file, 'utf8')) === content);

const env = { ...process.env };
if (!content) {
	env.WIKI_CONFIG = join(tmpdir(), 'wiki-test-has-no-config.json');
	delete env.WIKI_CONTENT_ROOT;
	delete env.WIKI_AGENTS_ROOT;
}

const child = spawn(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', '--test-timeout=300000', ...files], {
	stdio: 'inherit',
	env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
process.exit(await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1))));
