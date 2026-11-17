import { notFound } from "next/navigation";
import { secretOk } from "@/lib/auth";
import { blobConfigured, listUploads } from "@/lib/uploads";
import UploadPanel from "./UploadPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload lampiran – Loker MCP", robots: { index: false } };

export default async function UploadPage({ params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  if (!secretOk(secret)) notFound();

  if (!blobConfigured()) {
    return (
      <main style={{ maxWidth: 640 }}>
        <h1>Upload lampiran</h1>
        <p>
          Penyimpanan belum aktif. Buat <b>Blob store (private)</b> di Vercel → Storage, hubungkan ke project{" "}
          <code>loker-mcp</code>, lalu redeploy.
        </p>
      </main>
    );
  }

  const files = await listUploads();
  return <UploadPanel secret={secret} initialFiles={files} />;
}
