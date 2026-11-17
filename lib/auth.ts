import { timingSafeEqual } from "node:crypto";

/** Bandingkan secret di URL dengan env MCP_SECRET (constant-time). */
export function secretOk(given: string | undefined): boolean {
  const expected = process.env.MCP_SECRET;
  if (!given || !expected || expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
