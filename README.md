# Loker MCP: connector Claude untuk draft email lamaran kerja

Kirim info lowongan ke Claude (teks, screenshot poster, atau link). Claude membaca profilmu dari connector ini, menyusun email lamaran yang sesuai, lalu menyimpannya sebagai **draft di Gmail** lengkap dengan lampiran CV. Connector ini **tidak pernah mengirim email**. Kamu yang meninjau dan menekan *Kirim* sendiri.

```
Kamu ──info loker──▶ Claude ──get_applicant_profile──▶ Loker MCP (Vercel)
                       │                                   │
                       └──create_application_draft──▶  Gmail API ──▶ Draft + CV terlampir
```

## Tools yang tersedia

| Tool | Fungsi |
|---|---|
| `get_applicant_profile` | Membaca profil, gaya email, tanda tangan, dan daftar lampiran |
| `create_application_draft` | Membuat draft Gmail beserta lampiran (default: lampiran bertanda `default: true`) |
| `update_application_draft` | Menulis ulang draft (untuk revisi) |
| `get_application_draft` / `list_application_drafts` | Melihat draft |
| `delete_application_draft` | Menghapus draft |
| `check_application_history` | Mengecek apakah kamu pernah melamar atau dibalas oleh perusahaan tertentu |
| Prompt `tulis_lamaran` | Template cepat: tempel info loker, lalu Claude menjalankan seluruh alurnya |

Setiap draft otomatis diberi label Gmail **"Lamaran Kerja"** (bisa diubah lewat env `DRAFT_LABEL`).

---

## 1. Isi profil & lampiran

1. Salin `profile/profile.example.json` menjadi `profile/profile.json`, lalu isi dengan data aslimu. Semakin detail pencapaian (pakai angka), semakin bagus email yang dihasilkan.
2. Bagian `gaya_email` mengatur nada, panjang, format subjek, aturan, dan tanda tangan. Sesuaikan dengan seleramu.
3. Taruh CV di folder `private/` (mis. `private/CV_Nama.pdf`) dan daftarkan di `lampiran`:
   ```json
   { "kunci": "cv", "file": "CV_Nama.pdf", "deskripsi": "CV terbaru", "default": true }
   ```
   Lampiran juga bisa berupa URL unduhan langsung (https): `{ "kunci": "portofolio", "url": "https://...", "nama_file": "Portofolio.pdf" }`.

> ⚠️ `profile.json` dan isi `private/` ikut ter-commit. **Gunakan repo GitHub private.** Kalau tidak mau menyimpannya di repo, isi env `PROFILE_JSON` di Vercel dan pakai lampiran berbasis URL.

## 2. Siapkan akses Gmail (Google Cloud, sekali saja)

1. Buka <https://console.cloud.google.com/>, lalu buat project baru (mis. `loker-mcp`).
2. **APIs & Services → Library**: cari **Gmail API**, lalu klik **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, isi nama app dan email kamu.
   - Di **Audience / Test users**, tambahkan alamat Gmail-mu.
   - **Penting:** klik **Publish app** sehingga statusnya menjadi *In production*. Selama statusnya masih *Testing*, refresh token kedaluwarsa setiap 7 hari. App tidak perlu diverifikasi Google karena hanya kamu yang memakainya.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, lalu pilih tipe **Desktop app**. Catat **Client ID** dan **Client secret**.

## 3. Ambil refresh token (di komputermu)

```bash
npm install
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run token
```

Browser akan terbuka. Login dengan akun Gmail yang dipakai untuk melamar. Kalau muncul *"Google hasn't verified this app"*, klik **Advanced → Go to … (unsafe)**. Ini aman karena app-nya milikmu sendiri. Setelah itu, salin refresh token yang tampil di terminal.

Scope yang diminta adalah `gmail.modify`, yang dipakai untuk membuat, mengubah, dan menghapus draft, membaca email (untuk cek riwayat), dan mengelola label.

## 4. Deploy ke Vercel

1. Push proyek ini ke **repo GitHub private**.
2. Di <https://vercel.com/new>, import repo tersebut. Framework akan terdeteksi otomatis sebagai Next.js.
3. Di **Settings → Environment Variables**, isi:

   | Nama | Nilai |
   |---|---|
   | `MCP_SECRET` | string acak ≥16 karakter: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
   | `GOOGLE_CLIENT_ID` | dari langkah 2 |
   | `GOOGLE_CLIENT_SECRET` | dari langkah 2 |
   | `GOOGLE_REFRESH_TOKEN` | dari langkah 3 |
   | `SENDER_NAME`, `SENDER_EMAIL` | opsional, default diambil dari profil |
   | `PROFILE_JSON` | opsional, pengganti `profile/profile.json` |
   | `DRAFT_LABEL` | opsional, default `Lamaran Kerja` |

4. Klik **Deploy**. Kalau env baru diisi setelah deploy, lakukan **Redeploy**.
5. Cek `https://<nama-app>.vercel.app/`. Halaman "Loker MCP – server aktif" seharusnya tampil.

URL connector-mu: **`https://<nama-app>.vercel.app/mcp/<MCP_SECRET>`**

> Pakai domain **production** (`*.vercel.app` utama). URL preview biasanya terkunci oleh Vercel Deployment Protection, sehingga Claude tidak bisa mengaksesnya.

## 5. Tambahkan ke Claude

1. Claude → **Settings → Connectors → Add custom connector**. Di akun Team/Enterprise, Owner yang menambahkannya.
2. Nama: `Loker Mail`. URL: `https://<nama-app>.vercel.app/mcp/<MCP_SECRET>`. Kosongkan pengaturan OAuth.
3. Di chat, aktifkan connector lewat menu tools (ikon ➕ / 🔧).

## 6. Cara pakai

Cukup kirim info loker:

> Tolong buatkan draft lamaran untuk loker ini:
> *PT Maju Jaya membuka lowongan Backend Engineer (Go, PostgreSQL, min. 3 th). Kirim CV ke recruitment@majujaya.co.id dengan subjek: BE_Nama Lengkap. Deadline 30 Nov.*

Claude akan membaca profilmu, mengecek riwayat lamaran, menyusun email, lalu membuat draft dan memberikan link-nya. Kalau perlu revisi, minta saja: *"buat lebih singkat dan tonjolkan pengalaman Kafka"*. Claude akan memanggil `update_application_draft`.

Kamu juga bisa melampirkan screenshot poster loker. Claude membaca teksnya lalu menjalankan alur yang sama.

## Lampiran custom (cover letter, dll.)

Kalau lowongan meminta dokumen yang berbeda di tiap lamaran, misalnya cover letter, motivation letter, esai, atau jawaban pertanyaan rekruter, Claude menulis isinya dari profil dan iklan. Isi itu dikirim lewat parameter `custom_attachments`, lalu server mengubahnya menjadi **PDF A4** (Times, rapi) dan melampirkannya ke draft bersama CV.

Contoh: *"Buatkan draft lamaran untuk loker ini, sertakan cover letter terpisah dalam PDF."*

## Pengembangan lokal

```bash
cp .env.example .env.local   # isi nilainya
npm run dev
# Uji dengan MCP Inspector:
npx @modelcontextprotocol/inspector   # URL: http://localhost:3000/mcp/<MCP_SECRET>
```

## Keamanan

- Endpoint hanya merespons jika path berisi `MCP_SECRET` yang benar. Selain itu, responsnya 404. Perlakukan URL connector seperti password. Jika bocor, ganti `MCP_SECRET` lalu redeploy.
- Connector hanya membuat draft dan tidak punya tool untuk mengirim email.
- Refresh token memberi akses ke Gmail-mu, jadi simpan hanya di Environment Variables Vercel. Akses bisa dicabut kapan saja di <https://myaccount.google.com/permissions>.

## Troubleshooting

| Gejala | Solusi |
|---|---|
| `invalid_grant` | Refresh token kedaluwarsa atau dicabut. Pastikan app sudah *In production*, jalankan ulang `npm run token`, perbarui env, lalu redeploy |
| `GOOGLE_CLIENT_ID belum di-set` | Env belum diisi atau belum redeploy |
| `File private/... tidak ditemukan` | Nama file di `profile.json` tidak sama dengan nama file di folder `private/` (huruf besar/kecil berpengaruh) |
| Claude gagal connect | Pastikan URL production, secret benar, dan Deployment Protection tidak aktif di production |
| Label gagal dipasang | Tidak fatal, draft tetap dibuat. Set `DRAFT_LABEL=` (kosong) untuk menonaktifkan |
