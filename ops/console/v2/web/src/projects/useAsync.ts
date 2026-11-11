// One small loader hook for the project drill-down. The console's live state arrives over
// the WebSocket (data/ws.ts); these REST resources are pulled on open instead, because
// they are large, per-project and only interesting while the page is on screen.
//
// SSR safe: the effect never runs under renderToStaticMarkup, so the tree renders its
// loading state instead of throwing on a missing fetch.

import { useCallback, useEffect, useState } from "react";

export interface AsyncResult<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, key: string): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    setError(null);
    load(controller.signal)
      .then((value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted) return;
        setError(cause);
        setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
    // `key` is the identity of the request (project id, doc name, nonce): the loader
    // itself is recreated every render, so depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}
