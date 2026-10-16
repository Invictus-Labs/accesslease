/** Deterministic UTC clocks and synthetic identifiers. No test depends on the wall clock unless it says so. */

export const T0 = new Date("2026-09-28T12:00:00.000Z");
export const FIXTURE_VERSION = "1";

export interface TestClock {
  (): Date;
  /** Move time forward by whole seconds. */
  advance(seconds: number): void;
  /** Jump to an absolute instant. */
  set(at: Date): void;
  now(): Date;
}

export function fixedClock(start: Date = T0): TestClock {
  let current = start.getTime();
  const clock = (() => new Date(current)) as TestClock;
  clock.advance = (seconds) => {
    current += seconds * 1000;
  };
  clock.set = (at) => {
    current = at.getTime();
  };
  clock.now = clock;
  return clock;
}

export const isoPlus = (base: Date, seconds: number): string => new Date(base.getTime() + seconds * 1000).toISOString();

/** Deterministic, obviously synthetic UUIDs: <prefix>-0000-4000-8000-<12-digit counter>. */
export function syntheticIds(prefix = "a1"): () => string {
  let n = 0;
  const head = prefix.padEnd(8, "0").slice(0, 8);
  return () => {
    n += 1;
    return `${head}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/** A well-formed UUID that no installation will ever have issued: used for "missing object" probes. */
export const ghostId = (n: number): string => ["00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `fn` returns a truthy value; fail with a readable reason on timeout. */
export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}
