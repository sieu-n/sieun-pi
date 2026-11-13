import type { ratchet } from '../src/lib/prose-lint.mjs';
import type { HeldRow } from './dup-held.mjs';

export type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: string };
export type WriteChecks = {
	lint: ReturnType<typeof ratchet> | null;
	secrets: Settled<{ path: string; line: number; rule: string }[]>;
	held: Settled<{ added: HeldRow[]; kept: HeldRow[] }>;
};
export function writeChecks(input: { root: string; rel: string; before: string | null; after: string }): WriteChecks;
