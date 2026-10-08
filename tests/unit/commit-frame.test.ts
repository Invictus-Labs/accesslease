import { describe, expect, it } from "vitest";
import { commitFrameMatcher } from "../helpers/commit-frame.js";

function query(sql: string): Buffer {
  const body = Buffer.from(`${sql}\0`);
  const header = Buffer.alloc(5);
  header[0] = 0x51;
  header.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

describe("lost COMMIT answer fault target", () => {
  it("ignores READ COMMITTED and SQL text containing COMMIT, then matches the actual COMMIT frame", () => {
    const match = commitFrameMatcher();
    expect(match(query("BEGIN ISOLATION LEVEL READ COMMITTED"))).toBe(false);
    expect(match(query("SELECT 'COMMIT'"))).toBe(false);
    expect(match(query("COMMIT"))).toBe(true);
    expect(match(query("ROLLBACK"))).toBe(false);
  });
  it("matches every split of the exact frame and coalesced messages", () => {
    const commit = query("COMMIT");
    for (let split = 1; split < commit.length; split++) {
      const match = commitFrameMatcher();
      expect(match(commit.subarray(0, split))).toBe(false);
      expect(match(commit.subarray(split))).toBe(true);
    }
    expect(commitFrameMatcher()(Buffer.concat([query("BEGIN ISOLATION LEVEL READ COMMITTED"), commit]))).toBe(true);
  });
  it("keeps stream state isolated between connections", () => {
    const commit = query("COMMIT");
    const first = commitFrameMatcher();
    const second = commitFrameMatcher();
    expect(first(commit.subarray(0, 6))).toBe(false);
    expect(second(commit.subarray(6))).toBe(false);
    expect(first(commit.subarray(6))).toBe(true);
  });
});
