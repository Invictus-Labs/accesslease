import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/**
 * Load a resource; optionally keep polling while `shouldPoll(data)` holds (issuing, revoking and
 * uncertain leases change without user action). A response that belongs to a superseded request is ignored.
 */
export function useResource<T>(path: string, shouldPoll?: (data: T) => boolean, intervalMs = 3000): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const generation = useRef(0);
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    const request = ++generation.current;
    if (timer.current) clearTimeout(timer.current);
    api<T>("GET", path).then(
      (data) => {
        if (request !== generation.current) return;
        setState({ status: "ready", data });
        if (pollRef.current?.(data)) timer.current = setTimeout(load, intervalMs);
      },
      (error: Error) => {
        if (request === generation.current) setState({ status: "error", message: error.message });
      },
    );
  }, [path, intervalMs]);
  useEffect(() => {
    setState({ status: "loading" });
    load();
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);
  return [state, load];
}
