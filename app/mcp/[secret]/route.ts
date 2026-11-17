import { secretOk } from "@/lib/auth";
import { mcpHandler } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ secret: string }> };

async function handle(req: Request, { params }: Ctx) {
  const { secret } = await params;
  if (!secretOk(secret)) {
    return new Response("Not found", { status: 404 });
  }
  return mcpHandler(req);
}

export { handle as GET, handle as POST, handle as DELETE };
