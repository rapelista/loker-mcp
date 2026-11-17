"use client";

import { upload } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

type FileInfo = { nama: string; ukuran_kb: number; diupload: string };

const PREFIX = "lampiran/";
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx";

function sanitize(name: string) {
  const clean = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return clean || "file";
}

export default function UploadPanel({ secret, initialFiles }: { secret: string; initialFiles: FileInfo[] }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [rename, setRename] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setMsg(null);
    const done: string[] = [];
    try {
      for (const f of files) {
        let name = sanitize(files.length === 1 && rename.trim() ? rename.trim() : f.name);
        const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
        if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name = `${name}.${ext}`;
        await upload(PREFIX + name, f, {
          access: "private",
          handleUploadUrl: `/api/upload/${secret}`,
          contentType: f.type || undefined,
        });
        done.push(name);
      }
      setMsg({ ok: true, text: `Berhasil: ${done.join(", ")}` });
      setFiles([]);
      setRename("");
      (document.getElementById("file") as HTMLInputElement).value = "";
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: `Gagal: ${(err as Error).message}${done.length ? ` (sudah terupload: ${done.join(", ")})` : ""}` });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(nama: string) {
    if (!confirm(`Hapus ${nama}?`)) return;
    const res = await fetch(`/api/upload/${secret}?name=${encodeURIComponent(nama)}`, { method: "DELETE" });
    if (res.ok) router.refresh();
    else setMsg({ ok: false, text: `Gagal menghapus ${nama}` });
  }

  const box: React.CSSProperties = { border: "1px solid #ddd", borderRadius: 10, padding: 16, marginBottom: 20 };

  return (
    <main style={{ maxWidth: 680 }}>
      <h1 style={{ marginBottom: 4 }}>Upload lampiran</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        PDF, gambar (PNG/JPG/WebP), atau Word, maks 20 MB. Setelah diupload, minta Claude melampirkannya dengan menyebut
        nama filenya, mis. <i>&ldquo;lampirkan Cover_Letter_PT_ABC.pdf&rdquo;</i>.
      </p>

      <form onSubmit={onUpload} style={box}>
        <input id="file" type="file" accept={ACCEPT} multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        {files.length === 1 && (
          <div style={{ marginTop: 12 }}>
            <label>
              Ganti nama (opsional):{" "}
              <input
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                placeholder={files[0].name}
                style={{ width: "100%", padding: 6, marginTop: 4 }}
              />
            </label>
          </div>
        )}
        <button type="submit" disabled={busy || !files.length} style={{ marginTop: 12, padding: "8px 18px" }}>
          {busy ? "Mengupload…" : "Upload"}
        </button>
        <span style={{ fontSize: 13, color: "#777", marginLeft: 10 }}>Nama yang sama akan ditimpa.</span>
        {msg && <p style={{ color: msg.ok ? "green" : "crimson", marginBottom: 0 }}>{msg.text}</p>}
      </form>

      <h2 style={{ fontSize: 18 }}>File tersimpan ({initialFiles.length})</h2>
      {initialFiles.length === 0 ? (
        <p style={{ color: "#777" }}>Belum ada file.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            {initialFiles.map((f) => (
              <tr key={f.nama} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "8px 4px", wordBreak: "break-all" }}>
                  <code>{f.nama}</code>
                </td>
                <td style={{ padding: "8px 4px", color: "#777", whiteSpace: "nowrap" }}>{f.ukuran_kb} KB</td>
                <td style={{ padding: "8px 4px", color: "#777", whiteSpace: "nowrap" }}>
                  {new Date(f.diupload).toLocaleDateString("id-ID")}
                </td>
                <td style={{ padding: "8px 4px", textAlign: "right" }}>
                  <button onClick={() => onDelete(f.nama)} style={{ color: "crimson" }}>
                    Hapus
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
