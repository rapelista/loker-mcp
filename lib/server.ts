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
import { textToPdf } from "./pdf";
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
Lampiran custom: bila iklan atau pengguna meminta dokumen yang belum ada di profil (cover letter/surat lamaran, motivation letter, esai, jawaban pertanyaan), tulis isinya dari profil & lowongan lalu kirim lewat custom_attachments (server membuat PDF). Gabungkan dengan lampiran profil sesuai kebutuhan. Bila cover letter dilampirkan terpisah, badan email cukup singkat.
Jika email tujuan tidak ada di lowongan (mis. harus lewat portal), jangan buat draft; beri tahu pengguna dan tawarkan teks lamaran saja.`;

const emailList = z.array(z.email()).min(1);

const customAttachment = z.object({
  filename: z
    .string()
    .min(1)
    .max(120)
    .describe("Nama file di email, mis. 'Cover_Letter_Azhar_Salsabila_Naqiyah.pdf'. Ekstensi menentukan format bila 'format' kosong."),
  format: z
    .enum(["pdf", "txt"])
    .optional()
    .describe("pdf = teks dirender jadi PDF A4 rapi (untuk dokumen formal seperti cover letter); txt = file teks apa adanya. Default: dari ekstensi, selain itu pdf."),
  content: z
    .string()
    .min(20)
    .describe("Isi lengkap dokumen dalam teks polos. Paragraf dipisah baris kosong; baris '# Judul' dicetak tebal besar; baris '**teks**' dicetak tebal."),
});
type CustomAttachment = z.infer<typeof customAttachment>;

async function renderCustom(a: CustomAttachment, author?: string): Promise<LoadedAttachment> {
  const base = a.filename.replace(/[\\/\r\n"]/g, "_").trim();
  const stem = base.replace(/\.[^.]+$/, "");
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const format = a.format ?? (ext === "txt" ? "txt" : "pdf");
  if (format === "txt") {
    return { filename: `${stem}.txt`, mimeType: "text/plain", content: Buffer.from(a.content, "utf8") };
  }
  return {
    filename: `${stem}.pdf`,
    mimeType: "application/pdf",
    content: await textToPdf(a.content, stem.replace(/_/g, " "), author),
  };
}

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
  extra_attachment_urls: z
    .array(z.url())
    .optional()
    .describe("URL https tambahan untuk diunduh & dilampirkan (opsional)"),
  custom_attachments: z
    .array(customAttachment)
    .max(5)
    .optional()
    .describe(
      "Lampiran yang ditulis khusus untuk lamaran ini (cover letter/surat lamaran, motivation letter, esai, jawaban pertanyaan rekruter). Tulis isinya lengkap; server membuatkan PDF. Digabung dengan lampiran profil (attachments).",
    ),
};

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function resolveAttachments(
  profile: Profile,
  keys: string[] | undefined,
  urls: string[] | undefined,
  custom: CustomAttachment[] | undefined,
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
  const generated = await Promise.all((custom ?? []).map((c) => renderCustom(c, profile.nama_lengkap)));
  const extra = await Promise.all((urls ?? []).map(loadExtraUrl));
  const all = [...generated, ...files, ...extra];
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
    extra_attachment_urls?: string[];
    custom_attachments?: CustomAttachment[];
  },
) {
  const { files, used } = await resolveAttachments(
    profile,
    args.attachments,
    args.extra_attachment_urls,
    args.custom_attachments,
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
          "Membuat DRAFT email lamaran kerja di Gmail pengguna beserta lampiran: file dari profil (default: CV), dokumen custom yang ditulis Claude lalu dijadikan PDF oleh server (custom_attachments, mis. cover letter), dan/atau URL. Tidak mengirim email — pengguna meninjau & mengirim sendiri dari Gmail. Mengembalikan draft_id dan link ke draft.",
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
