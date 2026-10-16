import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageError } from "./exit.js";

/** Evidence directories and files are owner-only by default (PRD section 6). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Create a directory (and parents) readable only by the owner; tightens the mode of the leaf even if it already exists. */
export function ensureOwnerOnlyDir(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) throw new UsageError("output directory must not be a symbolic link");
    if (!statSync(abs).isDirectory()) throw new UsageError("output path exists and is not a directory");
  } else {
    mkdirSync(abs, { recursive: true, mode: DIR_MODE });
  }
  chmodSync(abs, DIR_MODE);
  return abs;
}

/** Prepare an output directory for a command that produces evidence. Refuses a non-empty directory unless forced. */
export function prepareOutputDir(path: string, force: boolean): string {
  const abs = resolve(path);
  if (existsSync(abs) && !force) {
    if (lstatSync(abs).isSymbolicLink()) throw new UsageError("output directory must not be a symbolic link");
    if (statSync(abs).isDirectory() && readdirSync(abs).length > 0) throw new UsageError(`output directory ${path} is not empty (use --force to write into it)`);
  }
  return ensureOwnerOnlyDir(abs);
}

/**
 * Write a file atomically with owner-only permissions. Refuses to write through a symbolic link.
 * Missing parent directories are created owner-only; an existing parent (for example the current directory)
 * is left exactly as it is: only the output file is tightened.
 */
export function writeOwnerOnlyFile(path: string, data: string | Uint8Array): string {
  const abs = resolve(path);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new UsageError("output file must not be a symbolic link");
  const parent = dirname(abs);
  if (existsSync(parent)) {
    if (!statSync(parent).isDirectory()) throw new UsageError("output location is not a directory");
  } else {
    mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  }
  const tmp = join(dirname(abs), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, abs);
  return abs;
}

/** Refuse to replace an existing output file unless forced. */
export function assertWritable(path: string, force: boolean): void {
  if (existsSync(path) && !force) throw new UsageError(`${path} already exists (use --force to replace it)`);
}

/** Read a bounded input file. The size is checked before the content is read (AC-09). */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  const abs = resolve(path);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
  if (!stat.isFile()) throw new UsageError(`${path} is not a regular file`);
  if (stat.size > maxBytes) throw new UsageError(`${path} is larger than the ${maxBytes} byte limit`);
  return readFileSync(abs);
}
