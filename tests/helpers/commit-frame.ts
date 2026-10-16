/** Match pg's simple-query COMMIT frame, including across TCP chunk boundaries.
 * A text substring also matches BEGIN ... READ COMMITTED and cuts the transaction
 * before issuance. Retain only the bounded suffix needed for a split frame.
 * This is a matcher for this fixture's pg query("COMMIT"), not a general SQL parser.
 */
export function commitFrameMatcher(): (chunk: Buffer) => boolean {
  const frame = Buffer.from([0x51, 0, 0, 0, 11, 0x43, 0x4f, 0x4d, 0x4d, 0x49, 0x54, 0]);
  let suffix = Buffer.alloc(0);
  return (chunk) => {
    const bytes = Buffer.concat([suffix, chunk]);
    const matched = bytes.includes(frame);
    suffix = Buffer.from(bytes.subarray(Math.max(0, bytes.length - frame.length + 1)));
    return matched;
  };
}
