import { timingSafeEqual } from "node:crypto";
import { mcpHandler } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function secretOk(given: string): boolean {
  const expected = process.env.MCP_SECRET;
  if (!expected || expected.length < 16) return false; // wajib di-set & cukup panjang
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Ctx = { params: Promise<{ secret: string }> };

async function handle(req: Request, { params }: Ctx) {
  const { secret } = await params;
  if (!secretOk(secret)) {
    return new Response("Not found", { status: 404 });
  }
  return mcpHandler(req);
}

export { handle as GET, handle as POST, handle as DELETE };
