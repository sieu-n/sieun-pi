// Lists env var NAMES (never values) in Railway, Vercel and GitHub Actions for vent-gateway.ts's provider_keys_outside_vent.
// Run from the auto-sns-agent root: node <this file> > out.json. Moved here on 11-04 from the vent cutover wiki session
// (1610-vent-cutover-all-callers/data), which left the repo with the wiki, so d1 read the metric as unmeasured.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const { vercelApi } = await import(pathToFileURL(join(process.cwd(), 'scripts/repo/env/vercel-blobs.mjs')).href);

const out = {};
const unreadable = {};
const add = (loc, names) => { out[loc] = [...new Set([...(out[loc] ?? []), ...names])].sort(); };

function railwayToken() {
	if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
	const m = readFileSync(join(homedir(), '.zshenv'), 'utf8').match(/RAILWAY_API_TOKEN=["']?([^"'\s]+)/);
	return m?.[1];
}
async function railway(query, variables) {
	const res = await fetch('https://backboard.railway.com/graphql/v2', {
		method: 'POST',
		headers: { Authorization: `Bearer ${railwayToken()}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	});
	const body = await res.json();
	if (body.errors) throw new Error(body.errors[0].message);
	return body.data;
}

try {
	const ws = (await railway('{ me { workspaces { id name } } }')).me.workspaces;
	const projects = [];
	for (const w of ws) projects.push(...(await railway('query($w:String){ projects(workspaceId:$w){ edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }', { w: w.id })).projects.edges);
	for (const { node: p } of projects) {
		for (const { node: env } of p.environments.edges) {
			for (const svc of [...p.services.edges.map((e) => e.node), null]) {
				try {
					const v = (await railway('query($p:String!,$e:String!,$s:String){ variables(projectId:$p, environmentId:$e, serviceId:$s, unrendered:true) }', { p: p.id, e: env.id, s: svc?.id ?? null })).variables;
					const names = Object.keys(v ?? {});
					if (names.length || svc) add(`railway ${p.name}/${env.name}/${svc?.name ?? '(shared)'}`, names);
				} catch (e) { unreadable[`railway ${p.name}/${env.name}/${svc?.name ?? '(shared)'}`] = e.message; }
			}
		}
	}
} catch (e) { unreadable.railway = e.message; }

try {
	let projects = [];
	let until;
	for (;;) {
		const r = await vercelApi('/v9/projects', { query: { limit: 100, ...(until ? { until } : {}) } });
		projects = projects.concat(r.projects);
		if (!r.pagination?.next) break;
		until = r.pagination.next;
	}
	for (const p of projects) {
		try {
			const { envs } = await vercelApi(`/v10/projects/${p.id}/env`);
			const byLoc = {};
			for (const e of envs) for (const t of e.target ?? ['(none)']) (byLoc[`vercel ${p.name} ${t}${e.gitBranch ? `:${e.gitBranch}` : ''}`] ??= []).push(e.key);
			if (!envs.length) add(`vercel ${p.name} (no rows)`, []);
			for (const [loc, names] of Object.entries(byLoc)) add(loc, names);
		} catch (e) { unreadable[`vercel ${p.name}`] = e.message; }
	}
} catch (e) { unreadable.vercel = e.message; }

const gh = (args) => spawnSync('gh', args, { encoding: 'utf8' });
const repo = 'sieu-n/auto-sns-agent';
for (const [loc, args] of [['github secrets repo', ['secret', 'list', '-R', repo]], ['github variables repo', ['variable', 'list', '-R', repo]]]) {
	const r = gh(args);
	if (r.status !== 0) unreadable[loc] = r.stderr.split('\n')[0];
	else add(loc, r.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean));
}
const envs = gh(['api', `repos/${repo}/environments`, '--jq', '.environments[].name']);
if (envs.status !== 0) unreadable['github environments'] = envs.stderr.split('\n')[0];
for (const env of envs.stdout.split('\n').filter(Boolean)) {
	for (const [kind, sub] of [['secrets', 'secret'], ['variables', 'variable']]) {
		const r = gh(['api', `repos/${repo}/environments/${encodeURIComponent(env)}/${kind}`, '--jq', `.${kind}[].name`]);
		if (r.status !== 0) unreadable[`github ${kind} env ${env}`] = r.stderr.split('\n')[0];
		else add(`github ${kind} env ${env}`, r.stdout.split('\n').filter(Boolean));
	}
}
const org = gh(['secret', 'list', '--org', 'sieu-n']);
if (org.status !== 0) unreadable['github secrets org'] = org.stderr.split('\n')[0];
else add('github secrets org', org.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean));

console.log(JSON.stringify({ out, unreadable }));
