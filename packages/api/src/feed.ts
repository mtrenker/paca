// What the SSE streams send: the latest value, recomputed on change, throttled.
/** The latest value of something the page shows, fanned out, throttled, to every open stream. */
export type Feed<T> = ReturnType<typeof createFeed<T>>;

export function createFeed<T>(compute: () => T, intervalMs = 120) {
	let timer: NodeJS.Timeout | undefined;
	let ended = false;
	const listeners = new Set<(value: T) => void>();
	const enders = new Set<() => void>();
	const dispose = () => {
		ended = true;
		clearTimeout(timer);
		listeners.clear();
		enders.clear();
	};
	return {
		current: () => compute(),
		/** `onEnd` runs when the feed ends, at once if it already has. */
		subscribe(fn: (value: T) => void, onEnd?: () => void) {
			if (ended) {
				onEnd?.();
				return () => {};
			}
			listeners.add(fn);
			if (onEnd) enders.add(onEnd);
			return () => {
				listeners.delete(fn);
				if (onEnd) enders.delete(onEnd);
			};
		},
		changed() {
			if (timer || ended) return;
			timer = setTimeout(() => {
				timer = undefined;
				const latest = compute();
				for (const fn of listeners) fn(latest);
			}, intervalMs);
		},
		/** Nothing more will change; subscribers are told once (a deleted session's `gone`). */
		end() {
			if (ended) return;
			const told = [...enders];
			dispose();
			for (const fn of told) fn();
		},
		/** Stops updates at shutdown without telling subscribers anything. */
		dispose,
	};
}
