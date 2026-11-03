/**
 * Wraps an expensive read so that concurrent calls with one key share a run. A call while a run is going waits
 * for the next run, which starts when the current one ends, so every caller gets a result that began after it
 * asked, and at most one run per key goes at a time with one more queued.
 */
export function sharedRuns<T>(run: (key: string) => Promise<T>): (key: string) => Promise<T> {
	const running = new Map<string, Promise<T>>();
	const queued = new Map<string, Promise<T>>();
	const start = (key: string): Promise<T> => {
		queued.delete(key);
		const current = run(key).finally(() => {
			if (running.get(key) === current) running.delete(key);
		});
		running.set(key, current);
		return current;
	};
	return (key) => {
		const next = queued.get(key);
		if (next) return next;
		const current = running.get(key);
		if (!current) return start(key);
		const after = current.then(
			() => start(key),
			() => start(key),
		);
		queued.set(key, after);
		return after;
	};
}
