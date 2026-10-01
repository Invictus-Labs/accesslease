/** Hostile text used for HTML-escaping, size and schema rejection tests. All payloads are inert and synthetic. */
export const HOSTILE_HTML = [
  `<script>window.__al_xss = 1</script>`,
  `<img src=x onerror="window.__al_xss = 2">`,
  `"><svg onload="window.__al_xss = 3">`,
  `<a href="javascript:window.__al_xss=4">click</a>`,
  `<iframe srcdoc="<script>parent.__al_xss=5</script>"></iframe>`,
  `{{constructor.constructor('window.__al_xss=6')()}}`,
] as const;

/** One string combining every payload; handy as a task_ref / reason / subject. */
export const HOSTILE_TEXT = HOSTILE_HTML.join(" ");

export const oversizeString = (bytes: number): string => "x".repeat(bytes);

/** A deeply nested JSON document to probe parser limits without exhausting memory. */
export function deepJson(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}
