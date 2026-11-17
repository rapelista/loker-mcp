#!/usr/bin/env node
// Jalankan di komputer sendiri (bukan di Vercel):
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run token
// atau isi keduanya di file .env lalu: node --env-file=.env scripts/get-refresh-token.mjs
// Browser akan terbuka → login ke akun Gmail yang dipakai melamar → izinkan → refresh token tampil di terminal.

import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET terlebih dahulu.");
  process.exit(1);
}

// gmail.modify mencakup: buat/ubah/hapus draft, baca pesan (cek riwayat), dan kelola label.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  if (url.searchParams.get("state") !== state) return res.writeHead(400).end("State tidak cocok");
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Otorisasi dibatalkan: " + url.searchParams.get("error"));
    return server.close();
  }
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const data = await tokenRes.json();
  if (!data.refresh_token) {
    console.error("\nGagal mendapat refresh token:", data);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Gagal, lihat terminal.");
  } else {
    console.log("\n✅ Berhasil! Simpan nilai ini sebagai GOOGLE_REFRESH_TOKEN di Vercel:\n");
    console.log(data.refresh_token + "\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Berhasil. Kembali ke terminal, jendela ini boleh ditutup.");
  }
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  console.log("Buka URL berikut di browser (mencoba membuka otomatis):\n\n" + authUrl + "\n");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${authUrl}"`, () => {});
});
