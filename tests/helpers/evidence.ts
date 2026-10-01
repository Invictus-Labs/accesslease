import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Sanitized evidence emitted by live tests (measured windows, versions, timings). Written only when ACCESSLEASE_EVIDENCE_DIR
 * is set (the gate sets it to the run's receipt directory). Never put credentials, URLs with passwords or hostnames here.
 */
export function recordEvidence(name: string, data: Record<string, unknown>): void {
  const dir = process.env.ACCESSLEASE_EVIDENCE_DIR;
  const body = { recorded_at: new Date().toISOString(), ...data };
  // Always echo so a developer running one test sees the measurement even without a receipt directory.
  console.log(`[evidence] ${name} ${JSON.stringify(body)}`);
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}
