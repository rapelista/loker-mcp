import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { buildMime } from "./mime";
import {
  createDraft,
  deleteDraft,
  draftLink,
  getDraft,
  labelMessage,
  listDrafts,
  searchMessages,
  updateDraft,
} from "./gmail";
import { blobConfigured, deleteUpload, listUploads, loadUpload, uploadPageUrl } from "./uploads";
import {
  describeAttachments,
  loadAttachment,
  loadExtraUrl,
  loadProfile,
  type LoadedAttachment,
  type Profile,
} from "./profile";

const INSTRUCTIONS = `Connector ini membantu menyusun email lamaran kerja dan menyimpannya sebagai DRAFT di Gmail pengguna (tidak pernah mengirim).
Alur kerja saat pengguna mengirim info lowongan (teks, poster yang sudah dibaca, atau link):
1. Panggil get_applicant_profile untuk membaca profil, gaya email, dan lampiran yang tersedia.
2. (Opsional) Panggil check_application_history dengan nama/domain perusahaan untuk mengecek apakah pernah melamar.
3. Ekstrak dari lowongan: perusahaan, posisi, email tujuan, format subjek yang diminta, dokumen yang diminta, bahasa iklan.
4. Susun email yang mencocokkan kualifikasi lowongan dengan pengalaman nyata di profil. Jangan mengarang fakta.
5. Panggil create_application_draft. Lalu berikan ringkasan singkat + link draft ke pengguna.
Lampiran tambahan (cover letter, portofolio khusus, gambar, dll.) diupload pengguna sendiri lewat halaman upload; lampirkan dengan uploaded_files memakai nama persis dari list_uploaded_files. Jika iklan meminta dokumen yang belum ada di profil maupun upload, beri tahu pengguna dan berikan link halaman upload (dari list_uploaded_files).
Jika email tujuan tidak ada di lowongan (mis. harus lewat portal), jangan buat draft; beri tahu pengguna dan tawarkan teks lamaran saja.`;

const emailList = z.array(z.email()).min(1);

const draftFields = {
  to: emailList.describe("Alamat email tujuan (HR/rekruter) dari iklan lowongan"),
  cc: z.array(z.email()).optional().describe("CC jika diminta di iklan"),
  bcc: z.array(z.email()).optional(),
  subject: z.string().min(3).max(250).describe("Subjek email. Ikuti format dari iklan bila ada."),
  body: z
    .string()
    .min(20)
    .describe("Isi email dalam teks polos (paragraf dipisah baris kosong), termasuk salam penutup dan tanda tangan. Akan otomatis dibuat versi HTML-nya."),
  attachments: z
    .array(z.string())
    .optional()
    .describe("Daftar 'kunci' lampiran dari profil (mis. ['cv','portofolio']). Kosongkan untuk memakai lampiran default; isi [] untuk tanpa lampiran."),
  uploaded_files: z
    .array(z.string())
    .optional()
    .describe("Nama file yang sudah diupload pengguna lewat halaman upload (lihat list_uploaded_files), mis. ['Cover_Letter_PT_ABC.pdf']. Ditambahkan ke lampiran profil."),
  extra_attachment_urls: z
    .array(z.url())
    .optional()
    .describe("URL https tambahan untuk diunduh & dilampirkan (opsional)"),
};

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function resolveAttachments(
  profile: Profile,
  keys: string[] | undefined,
  urls: string[] | undefined,
  uploaded: string[] | undefined,
): Promise<{ files: LoadedAttachment[]; used: string[] }> {
  const specs = profile.lampiran ?? [];
  const chosen =
    keys === undefined
      ? specs.filter((s) => s.default)
      : keys.map((k) => {
          const s = specs.find((x) => x.kunci === k);
          if (!s) throw new Error(`Lampiran dengan kunci "${k}" tidak ada di profil. Tersedia: ${specs.map((x) => x.kunci).join(", ") || "-"}`);
          return s;
        });
  const files = await Promise.all(chosen.map(loadAttachment));
  const fromUploads = await Promise.all((uploaded ?? []).map(loadUpload));
  const extra = await Promise.all((urls ?? []).map(loadExtraUrl));
  const all = [...files, ...fromUploads, ...extra];
  const total = all.reduce((n, f) => n + f.content.length, 0);
  if (total > 24 * 1024 * 1024) throw new Error("Total lampiran melebihi 24MB (batas Gmail 25MB).");
  return { files: all, used: all.map((f) => `${f.filename} (${Math.round(f.content.length / 1024)} KB)`) };
}

async function buildRaw(
  profile: Profile,
  args: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    attachments?: string[];
    uploaded_files?: string[];
    extra_attachment_urls?: string[];
  },
) {
  const { files, used } = await resolveAttachments(
    profile,
    args.attachments,
    args.extra_attachment_urls,
    args.uploaded_files,
  );
  const raw = buildMime({
    from: {
      name: process.env.SENDER_NAME || profile.nama_lengkap,
      email: process.env.SENDER_EMAIL || profile.email,
    },
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body,
    attachments: files,
  });
  return { raw, used };
}

async function applyLabel(messageId: string) {
  const label = process.env.DRAFT_LABEL ?? "Lamaran Kerja";
  if (!label) return undefined;
  const err = await labelMessage(messageId, label);
  return err ? `Label "${label}" gagal dipasang: ${err}` : `Label "${label}" terpasang`;
}

export const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_applicant_profile",
      {
        title: "Baca profil pelamar",
        description:
          "Mengambil profil pelamar (data diri, pengalaman, keahlian, preferensi), panduan gaya email lamaran, tanda tangan, dan daftar lampiran (CV dll.) yang tersedia. Panggil ini SEBELUM menyusun email lamaran.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          const { profile, source } = await loadProfile();
          const lampiran = await describeAttachments(profile);
          return json({ sumber_profil: source, profil: { ...profile, lampiran: undefined }, lampiran_tersedia: lampiran });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "create_application_draft",
      {
        title: "Buat draft email lamaran di Gmail",
        description:
          "Membuat DRAFT email lamaran kerja di Gmail pengguna beserta lampiran: file dari profil (default: CV), file yang diupload pengguna (uploaded_files, mis. cover letter), dan/atau URL. Tidak mengirim email — pengguna meninjau & mengirim sendiri dari Gmail. Mengembalikan draft_id dan link ke draft.",
        inputSchema: z.object({
          ...draftFields,
          company: z.string().optional().describe("Nama perusahaan (untuk ringkasan)"),
          position: z.string().optional().describe("Nama posisi (untuk ringkasan)"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const { profile } = await loadProfile();
          const { raw, used } = await buildRaw(profile, args);
          const draft = await createDraft(raw);
          const label = await applyLabel(draft.message.id);
          return json({
            status: "Draft berhasil dibuat (belum dikirim)",
            draft_id: draft.id,
            link: draftLink(draft.message.id),
            perusahaan: args.company,
            posisi: args.position,
            kepada: args.to,
            subjek: args.subject,
            lampiran: used,
            label,
          });
        } catch (e) {
          return fail(`Gagal membuat draft: ${(e as Error).message}`);
        }
      },
    );

    server.registerTool(
      "update_application_draft",
      {
        title: "Perbarui draft lamaran",
        description:
          "Mengganti isi draft yang sudah ada (penerima, subjek, isi, lampiran) — mis. setelah pengguna minta revisi. Semua field ditulis ulang, jadi kirim versi lengkap. Gunakan get_application_draft dulu bila perlu isi lamanya.",
        inputSchema: z.object({ draft_id: z.string().min(1), ...draftFields }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ draft_id, ...args }) => {
        try {
          const { profile } = await loadProfile();
          const { raw, used } = await buildRaw(profile, args);
          const draft = await updateDraft(draft_id, raw);
          const label = await applyLabel(draft.message.id);
          return json({ status: "Draft diperbarui", draft_id: draft.id, link: draftLink(draft.message.id), lampiran: used, label });
        } catch (e) {
          return fail(`Gagal memperbarui draft: ${(e as Error).message}`);
        }
      },
    );

    server.registerTool(
      "list_application_drafts",
      {
        title: "Daftar draft lamaran",
        description:
          "Menampilkan draft email di Gmail (terbaru dulu). Bisa difilter dengan query pencarian Gmail, mis. 'subject:lamaran' atau 'to:@tokopedia.com'.",
        inputSchema: z.object({
          query: z.string().optional().describe("Query pencarian Gmail (opsional)"),
          max: z.number().int().min(1).max(25).default(10),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ query, max }) => {
        try {
          return json(await listDrafts(query, max));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "get_application_draft",
      {
        title: "Lihat isi draft",
        description: "Mengambil isi lengkap satu draft (penerima, subjek, isi teks, nama lampiran).",
        inputSchema: z.object({ draft_id: z.string().min(1) }),
        annotations: { readOnlyHint: true },
      },
      async ({ draft_id }) => {
        try {
          return json(await getDraft(draft_id));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "delete_application_draft",
      {
        title: "Hapus draft",
        description: "Menghapus permanen satu draft dari Gmail. Hanya lakukan bila pengguna memintanya secara eksplisit.",
        inputSchema: z.object({ draft_id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ draft_id }) => {
        try {
          await deleteDraft(draft_id);
          return json({ status: "Draft dihapus", draft_id });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "list_uploaded_files",
      {
        title: "Daftar file upload",
        description:
          "Menampilkan file lampiran yang sudah diupload pengguna (cover letter, portofolio, gambar, dll.) beserta link halaman upload. Pakai nama file dari sini untuk parameter uploaded_files.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        const halaman_upload = uploadPageUrl();
        if (!blobConfigured()) {
          return json({
            status: "Penyimpanan upload belum aktif (Vercel Blob belum terhubung ke project).",
            halaman_upload,
          });
        }
        try {
          const files = await listUploads();
          return json({ halaman_upload, jumlah: files.length, files });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "delete_uploaded_file",
      {
        title: "Hapus file upload",
        description: "Menghapus permanen satu file upload. Hanya lakukan bila pengguna memintanya secara eksplisit.",
        inputSchema: z.object({ name: z.string().min(1).describe("Nama file persis dari list_uploaded_files") }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ name }) => {
        try {
          await deleteUpload(name);
          return json({ status: "File dihapus", name });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "check_application_history",
      {
        title: "Cek riwayat lamaran",
        description:
          "Mencari email terkirim, draft, dan balasan terkait sebuah perusahaan/domain di Gmail untuk mengecek apakah pengguna pernah melamar ke sana.",
        inputSchema: z.object({
          keyword: z.string().min(2).describe("Nama perusahaan atau domain email, mis. 'Tokopedia' atau 'tokopedia.com'"),
          months: z.number().int().min(1).max(36).default(12).describe("Rentang waktu ke belakang (bulan)"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ keyword, months }) => {
        try {
          const k = keyword.replace(/["()]/g, "").trim();
          const isDomain = /\.[a-z]{2,}$/i.test(k) && !k.includes(" ");
          const term = isDomain ? `(to:${k} OR from:${k})` : `"${k}"`;
          const q = `${term} newer_than:${months}m (in:sent OR in:drafts OR in:inbox)`;
          const hasil = await searchMessages(q, 15);
          return json({ query: q, jumlah: hasil.length, hasil });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerPrompt(
      "tulis_lamaran",
      {
        title: "Tulis lamaran dari info loker",
        description: "Tempel info lowongan; Claude akan menyusun email lamaran dan menyimpannya sebagai draft Gmail.",
        argsSchema: z.object({
          info_loker: z.string().describe("Teks iklan lowongan, atau link-nya"),
          catatan: z.string().optional().describe("Catatan tambahan, mis. 'tonjolkan pengalaman Kafka'"),
        }),
      },
      ({ info_loker, catatan }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Tolong buatkan draft email lamaran untuk lowongan berikut.\n\n${info_loker}\n\n${catatan ? `Catatan: ${catatan}\n\n` : ""}Langkah: baca profil saya (get_applicant_profile), cek riwayat lamaran ke perusahaan ini, susun email sesuai gaya di profil, lalu simpan dengan create_application_draft. Tunjukkan ringkasan dan link draft.`,
            },
          },
        ],
      }),
    );
  },
  {
    serverInfo: { name: "loker-mail", version: "1.0.0" },
    instructions: INSTRUCTIONS,
  },
);
