import type { ratchet } from '../src/lib/prose-lint.mjs';
import type { HeldRow } from './dup-held.mjs';

export type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: string };
export type WriteChecks = {
	lint: ReturnType<typeof ratchet> | null;
	secrets: Settled<{ path: string; line: number; rule: string }[]>;
	held: Settled<{ added: HeldRow[]; kept: HeldRow[] }>;
};
export function writeChecks(input: { root: string; rel: string; before: string | null; after: string }): WriteChecks;

type Gate = { code: string; rel: string; before: string | null; after: string; summary?: string };
/** The worker's tasks by name, with the input each takes and the result it answers. */
export type WriteTasks = {
	checks: { input: { root: string; rel: string; before: string | null; after: string }; output: WriteChecks };
	gateReasons: { input: Gate; output: string[] };
	gateWarnings: { input: Gate; output: string[] };
};
