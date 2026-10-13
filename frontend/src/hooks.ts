import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	refresh: () => void;
}

/**
 * Fetch-on-mount + manual refresh + optional polling.
 * Cancels in-flight requests on unmount / param change.
 */
export function useFetch<T>(fetcher: () => Promise<T>, pollMs?: number, watchKey?: unknown): AsyncState<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);

		const run = async () => {
			try {
				const result = await fetcherRef.current();
				if (!cancelled) {
					setData(result);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		void run();
		let timer: ReturnType<typeof setInterval> | undefined;
		if (pollMs && pollMs > 0) {
			timer = setInterval(() => void run(), pollMs);
		}
		return () => {
			cancelled = true;
			if (timer) clearInterval(timer);
		};
	}, [nonce, pollMs, watchKey]);

	const refresh = useCallback(() => setNonce((n) => n + 1), []);
	return { data, loading, error, refresh };
}

/** Debounce a changing value (filter inputs). */
export function useDebounced<T>(value: T, delayMs = 400): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(t);
	}, [value, delayMs]);
	return debounced;
}
