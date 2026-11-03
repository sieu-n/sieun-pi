import type { RequestEvent } from '@sveltejs/kit';
import { error, json } from '@sveltejs/kit';
import type { SpecPatch } from '$lib/components/specs/types';
import { SPEC_ID, commitSpec, jsonBody, writeSpec } from '../store.server';

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Rewrites the spec file. `status: 'approved'` also commits the file through commit.mjs;
 * a refusal from commit.mjs answers 409 with its words and the file stays written.
 */
export async function PATCH(event: RequestEvent) {
	const input = await jsonBody(event);
	const id = event.params.specId ?? '';
	if (!SPEC_ID.test(id)) error(400, 'Invalid spec id.');
	const patch: SpecPatch = { title: text(input.title), journey: text(input.journey), notes: text(input.notes) };
	if (Array.isArray(input.criteria))
		patch.criteria = input.criteria.map((item) => {
			const entry = item as { index?: unknown; text?: unknown };
			if (typeof entry.index !== 'number' || typeof entry.text !== 'string')
				error(400, 'Criteria need index and text.');
			return { index: entry.index, text: entry.text };
		});
	if (input.status !== undefined) {
		if (input.status !== 'draft' && input.status !== 'approved') error(400, 'Status is draft or approved.');
		patch.status = input.status;
	}
	const spec = writeSpec(id, patch);
	if (patch.status === 'approved') {
		const commit = await commitSpec(spec, `specs(${id}): approved`);
		if (!commit.ok) error(409, `The file is approved on disk, but commit.mjs refused:\n${commit.output}`);
		return json({ id, status: spec.status, commit: commit.output });
	}
	return json({ id, status: spec.status });
}
