import { createHash, randomUUID } from "node:crypto";

/**
 * Identifier source for every row AccessLease creates. Production uses random UUIDs; the offline demo swaps in a
 * counter-derived generator so the demo's evidence is reproducible byte for byte (with its fixed clock).
 */
let generator: () => string = () => randomUUID();

export const newId = (): string => generator();

/** Deterministic UUID-shaped identifiers: `uuid(seed, n)`; version/variant bits are set so they parse as UUID v4. */
export function deterministicIds(seed: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = createHash("sha256").update(`${seed}:${n}`).digest("hex");
    const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

/** Run `fn` with a different id generator, restoring the previous one afterwards. Not for concurrent use. */
export async function withIdGenerator<T>(next: () => string, fn: () => Promise<T>): Promise<T> {
  const previous = generator;
  generator = next;
  try {
    return await fn();
  } finally {
    generator = previous;
  }
}
