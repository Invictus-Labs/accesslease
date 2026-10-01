/**
 * Planted fake secrets. They are shaped like real credentials so any scanner (and the product's redactor) must treat them
 * as secrets, yet none is live: they are documentation-style examples or sequential filler. Deliberately they do NOT contain
 * words such as "fake" or "planted", because the product redactor also scrubs those words and a test that only passes
 * thanks to a keyword would prove nothing. Tests plant them into free-text request fields, then assert they never surface in
 * logs, API errors, exports or reports. Secrets AccessLease itself handles (issued credentials, the provider admin password)
 * are added at run time through the `extra` argument.
 */
export const PLANTED_SECRETS = {
  githubToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  awsKeyId: "AKIAIOSFODNN7EXAMPLE",
  slackToken: "xoxb-" + "000000000000-000000000000-abcdefghijklmnopqrstuvwx",
  jwt: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLWV4YW1wbGU",
  bearer: "Bearer abcdefghijklmnop0123456789",
  passwordAssignment: "password=Tr0ub4dor&3-example",
  privateKeyBody: "bm90LWEtcmVhbC1rZXktanVzdC1maWxsZXItdGV4dC1mb3ItdGVzdHM=",
} as const;

/** The secret substrings that must never appear anywhere observable. */
export const PLANTED_VALUES: string[] = [
  PLANTED_SECRETS.githubToken,
  PLANTED_SECRETS.awsKeyId,
  PLANTED_SECRETS.slackToken,
  PLANTED_SECRETS.jwt,
  "abcdefghijklmnop0123456789",
  "Tr0ub4dor&3-example",
  // Fragments: a redactor that stops at a delimiter inside a secret must still be caught.
  "Tr0ub4dor",
  "3-example",
  "abcdefghijklmnopqrstuvwxyz0123456789",
  "000000000000-abcdefghijklmnopqrstuvwx",
  "eyJzdWIiOiJleGFtcGxlIn0",
  PLANTED_SECRETS.privateKeyBody,
];

/** Short carriers (each under the 200 character reference limit) that together contain every planted secret. */
export const plantedPieces = (label: string): string[] => [
  `${label} token ${PLANTED_SECRETS.githubToken} aws ${PLANTED_SECRETS.awsKeyId}`,
  `${label} slack ${PLANTED_SECRETS.slackToken} ${PLANTED_SECRETS.passwordAssignment}`,
  `${label} ${PLANTED_SECRETS.bearer} jwt ${PLANTED_SECRETS.jwt}`,
  `${label} -----BEGIN PRIVATE KEY-----${PLANTED_SECRETS.privateKeyBody}-----END PRIVATE KEY-----`,
];

/** Free-text carrier combining every planted secret in plausible request wording. */
export const plantedCarrier = (label: string): string =>
  `${label} token ${PLANTED_SECRETS.githubToken} aws ${PLANTED_SECRETS.awsKeyId} slack ${PLANTED_SECRETS.slackToken} ${PLANTED_SECRETS.passwordAssignment} ${PLANTED_SECRETS.bearer} jwt ${PLANTED_SECRETS.jwt} -----BEGIN PRIVATE KEY-----${PLANTED_SECRETS.privateKeyBody}-----END PRIVATE KEY-----`;

/** Return every planted value found in `haystack` (empty array means clean). */
export function leakedSecrets(haystack: string, extra: readonly string[] = []): string[] {
  return [...PLANTED_VALUES, ...extra].filter((value) => value.length > 0 && haystack.includes(value));
}

export function assertNoSecrets(label: string, haystack: string, extra: readonly string[] = []): void {
  const found = leakedSecrets(haystack, extra);
  if (found.length > 0) throw new Error(`${label} leaked ${found.length} planted secret(s): ${found.map((s) => `${s.slice(0, 6)}...`).join(", ")}`);
}
