import type { RequestEvent } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { REPO, SPECS_IN_REPO, SPEC_ID, jsonBody } from '../store.server';

const ENVS = new Set(['local', 'staging', 'prod']);
/** spec ids with a runner child alive in this server process */
const running = new Set<string>();

/**
 * Starts `node apps/specs/run.mjs --spec SPEC-n --env <envs> [--only <check>]` and streams its
 * output as server-sent events: `data:` per output chunk, then `event: done` with the exit code.
 * One run at a time per spec; a second request answers 409.
 */
export async function POST(event: RequestEvent) {
	const input = await jsonBody(event);
	const spec = String(input.spec ?? '');
	if (!SPEC_ID.test(spec)) error(400, 'Invalid spec id.');
	const check = input.check === undefined ? null : String(input.check);
	if (check !== null && !/^[\w.-]{1,80}$/.test(check)) error(400, 'Invalid check name.');
	const envs = typeof input.env === 'string' ? input.env.split(',') : ['local', 'staging', 'prod'];
	if (!envs.length || envs.some((name) => !ENVS.has(name))) error(400, 'env is local, staging or prod.');
	if (running.has(spec)) error(409, `${spec} is already running.`);
	running.add(spec);

	const args = [`${SPECS_IN_REPO}/run.mjs`, '--spec', spec, '--env', envs.join(',')];
	if (check) args.push('--only', check);
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string, name?: string) => {
				const lines = text
					.split('\n')
					.map((line) => `data: ${line}`)
					.join('\n');
				controller.enqueue(encoder.encode(`${name ? `event: ${name}\n` : ''}${lines}\n\n`));
			};
			send(`$ node ${args.join(' ')}`);
			const child = spawn('node', args, {
				cwd: REPO,
				env: { ...process.env, FORCE_COLOR: '0' },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let open = true;
			const finish = (code: number | null, why: string) => {
				if (!open) return;
				open = false;
				running.delete(spec);
				send(JSON.stringify({ code, why }), 'done');
				controller.close();
			};
			child.stdout.on('data', (chunk: Buffer) => open && send(chunk.toString('utf8').replace(/\n$/, '')));
			child.stderr.on('data', (chunk: Buffer) => open && send(chunk.toString('utf8').replace(/\n$/, '')));
			child.on('error', (failure) => {
				send(`could not start the runner: ${failure.message}`);
				finish(null, 'error');
			});
			child.on('close', (code) => finish(code, 'exit'));
			event.request.signal.addEventListener('abort', () => {
				if (!open) return;
				child.kill('SIGTERM');
				running.delete(spec);
				open = false;
			});
		},
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}
