import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot: string | undefined;

/** Walk up from this module until the AccessLease package.json is found (works from src/ and dist/src/). */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "accesslease") {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // an unreadable manifest is not ours; keep walking
      }
    }
    dir = dirname(dir);
  }
  throw new Error("accesslease: package assets not found (package.json missing)");
}

/** Absolute path of a file shipped inside the package (templates, web bundle, migrations). */
export const assetPath = (...parts: string[]): string => join(packageRoot(), ...parts);

export const loadReportTemplate = (): string => readFileSync(assetPath("templates", "report.html"), "utf8");
