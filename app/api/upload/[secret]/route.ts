import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { secretOk } from "@/lib/auth";
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, UPLOAD_PREFIX, deleteUpload } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ secret: string }> };

/** Menerbitkan token upload langsung dari browser ke Vercel Blob (private). */
export async function POST(req: Request, { params }: Ctx) {
  const { secret } = await params;
  if (!secretOk(secret)) return new Response("Not found", { status: 404 });

  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(UPLOAD_PREFIX) || pathname.slice(UPLOAD_PREFIX.length).includes("/")) {
          throw new Error("Path upload tidak valid");
        }
        return {
          allowedContentTypes: ALLOWED_UPLOAD_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
          allowOverwrite: true,
        };
      },
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Hapus file: DELETE /api/upload/<secret>?name=<nama> */
export async function DELETE(req: Request, { params }: Ctx) {
  const { secret } = await params;
  if (!secretOk(secret)) return new Response("Not found", { status: 404 });
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return Response.json({ error: "name wajib" }, { status: 400 });
  try {
    await deleteUpload(name);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
