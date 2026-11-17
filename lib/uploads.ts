import { del, get, list } from "@vercel/blob";
import type { LoadedAttachment } from "./profile";
import { guessMime } from "./profile";

/** Semua file upload disimpan di Vercel Blob (private) dengan prefix ini. */
export const UPLOAD_PREFIX = "lampiran/";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function blobConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function requireBlob() {
  if (!blobConfigured()) {
    throw new Error(
      "Penyimpanan upload belum aktif: hubungkan Vercel Blob store (private) ke project ini agar BLOB_READ_WRITE_TOKEN tersedia, lalu redeploy.",
    );
  }
}

/** Nama file aman: huruf, angka, titik, minus, underscore. */
export function sanitizeFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return clean || "file";
}

export function uploadPageUrl(): string | undefined {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const secret = process.env.MCP_SECRET;
  return host && secret ? `https://${host}/upload/${secret}` : undefined;
}

export async function listUploads() {
  requireBlob();
  const out: { nama: string; ukuran_kb: number; diupload: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ prefix: UPLOAD_PREFIX, cursor, limit: 1000 });
    for (const b of res.blobs) {
      out.push({
        nama: b.pathname.slice(UPLOAD_PREFIX.length),
        ukuran_kb: Math.round(b.size / 1024),
        diupload: new Date(b.uploadedAt).toISOString(),
      });
    }
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.diupload.localeCompare(a.diupload));
}

export async function loadUpload(name: string): Promise<LoadedAttachment> {
  requireBlob();
  const clean = sanitizeFilename(name);
  const res = await get(UPLOAD_PREFIX + clean, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) {
    const ada = (await listUploads()).map((f) => f.nama);
    throw new Error(`File upload "${name}" tidak ditemukan. Tersedia: ${ada.join(", ") || "(belum ada)"}`);
  }
  const content = Buffer.from(await new Response(res.stream).arrayBuffer());
  return { filename: clean, mimeType: res.blob.contentType || guessMime(clean), content };
}

export async function deleteUpload(name: string) {
  requireBlob();
  await del(UPLOAD_PREFIX + sanitizeFilename(name));
}
