import { promises as fs } from "node:fs";
import path from "node:path";

export interface AttachmentSpec {
  kunci: string;
  file?: string; // nama file di folder private/
  url?: string; // atau URL unduhan langsung
  nama_file?: string; // nama file yang tampil di email (wajib jika pakai url)
  deskripsi?: string;
  default?: boolean;
}

export interface Profile {
  nama_lengkap: string;
  email: string;
  lampiran?: AttachmentSpec[];
  gaya_email?: Record<string, unknown> & { tanda_tangan?: string };
  [key: string]: unknown;
}

const ROOT = process.cwd();
let cached: { profile: Profile; source: string } | null = null;

function parseProfileEnv(raw: string): Profile {
  const trimmed = raw.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json) as Profile;
}

/** Urutan: env PROFILE_JSON → profile/profile.json → profile/profile.example.json */
export async function loadProfile(): Promise<{ profile: Profile; source: string }> {
  if (cached) return cached;

  if (process.env.PROFILE_JSON) {
    cached = { profile: parseProfileEnv(process.env.PROFILE_JSON), source: "env:PROFILE_JSON" };
    return cached;
  }

  for (const name of ["profile.json", "profile.example.json"]) {
    const p = path.join(ROOT, "profile", name);
    try {
      const txt = await fs.readFile(p, "utf8");
      cached = { profile: JSON.parse(txt) as Profile, source: `profile/${name}` };
      return cached;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error("Profil tidak ditemukan. Isi profile/profile.json atau env PROFILE_JSON.");
}

export interface LoadedAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
  ".txt": "text/plain",
};

export function guessMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

async function fetchUrl(url: string, filename?: string): Promise<LoadedAttachment> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`Lampiran URL harus https: ${url}`);
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) throw new Error(`Gagal mengunduh lampiran ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`Lampiran terlalu besar (>20MB): ${url}`);
  const name = filename || decodeURIComponent(u.pathname.split("/").pop() || "lampiran");
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || guessMime(name);
  return { filename: name, mimeType, content: buf };
}

export async function loadAttachment(spec: AttachmentSpec): Promise<LoadedAttachment> {
  if (spec.file) {
    // Cegah path traversal: hanya nama file di dalam private/
    const safeName = path.basename(spec.file);
    const content = await fs.readFile(path.join(ROOT, "private", safeName));
    return { filename: spec.nama_file || safeName, mimeType: guessMime(safeName), content };
  }
  if (spec.url) return fetchUrl(spec.url, spec.nama_file);
  throw new Error(`Lampiran "${spec.kunci}" tidak punya 'file' atau 'url'.`);
}

export async function loadExtraUrl(url: string): Promise<LoadedAttachment> {
  return fetchUrl(url);
}

/** Cek ketersediaan lampiran tanpa memuat isinya penuh (untuk ditampilkan ke Claude). */
export async function describeAttachments(profile: Profile) {
  const list = profile.lampiran ?? [];
  return Promise.all(
    list.map(async (a) => {
      let tersedia = true;
      let catatan: string | undefined;
      if (a.file) {
        try {
          await fs.access(path.join(ROOT, "private", path.basename(a.file)));
        } catch {
          tersedia = false;
          catatan = `File private/${a.file} tidak ditemukan`;
        }
      }
      return {
        kunci: a.kunci,
        deskripsi: a.deskripsi,
        sumber: a.file ? `private/${a.file}` : a.url,
        default: !!a.default,
        tersedia,
        ...(catatan ? { catatan } : {}),
      };
    }),
  );
}
