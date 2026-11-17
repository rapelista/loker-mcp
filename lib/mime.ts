import { randomBytes } from "node:crypto";
import type { LoadedAttachment } from "./profile";

export interface MailInput {
  from: { name?: string; email: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: LoadedAttachment[];
}

const CRLF = "\r\n";

function isAscii(s: string) {
  return /^[\x20-\x7e]*$/.test(s);
}

/** RFC 2047 encoded-word untuk header non-ASCII */
export function encodeHeader(value: string): string {
  if (isAscii(value)) return value;
  // Pecah per ~45 byte agar tiap encoded-word ≤ 75 karakter
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(CRLF + " ");
}

function formatAddress(name: string | undefined, email: string) {
  if (!name) return email;
  const safe = isAscii(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeader(name);
  return `${safe} <${email}>`;
}

function wrapBase64(buf: Buffer) {
  return buf.toString("base64").replace(/.{1,76}/g, (m) => m + CRLF);
}

function sanitizeHeaderValue(v: string) {
  // Cegah header injection
  return v.replace(/[\r\n]+/g, " ").trim();
}

function filenameParams(filename: string) {
  const clean = sanitizeHeaderValue(filename);
  if (isAscii(clean)) return `filename="${clean.replace(/"/g, "")}"`;
  return `filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function nameParam(filename: string) {
  const clean = sanitizeHeaderValue(filename);
  if (isAscii(clean)) return `name="${clean.replace(/"/g, "")}"`;
  return `name="${encodeHeader(clean)}"`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Ubah teks polos menjadi HTML sederhana: paragraf, baris baru, dan tautan aktif. */
export function textToHtml(text: string): string {
  const linkify = (s: string) =>
    s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>');
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">\n${paragraphs}\n</div>`;
}

export function buildMime(input: MailInput): string {
  const boundaryMixed = "mixed_" + randomBytes(12).toString("hex");
  const boundaryAlt = "alt_" + randomBytes(12).toString("hex");
  const html = input.html ?? textToHtml(input.text);
  const attachments = input.attachments ?? [];

  const headers = [
    `From: ${formatAddress(input.from.name, input.from.email)}`,
    `To: ${input.to.map(sanitizeHeaderValue).join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(input.replyTo ? [`Reply-To: ${sanitizeHeaderValue(input.replyTo)}`] : []),
    `Subject: ${encodeHeader(sanitizeHeaderValue(input.subject))}`,
    `MIME-Version: 1.0`,
  ];

  const altPart = [
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(Buffer.from(input.text.replace(/\r?\n/g, CRLF), "utf8")),
    `--${boundaryAlt}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(Buffer.from(html, "utf8")),
    `--${boundaryAlt}--`,
  ].join(CRLF);

  if (attachments.length === 0) {
    return [...headers, altPart, ""].join(CRLF);
  }

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    `--${boundaryMixed}`,
    altPart,
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundaryMixed}`,
      `Content-Type: ${a.mimeType}; ${nameParam(a.filename)}`,
      `Content-Disposition: attachment; ${filenameParams(a.filename)}`,
      `Content-Transfer-Encoding: base64`,
      "",
      wrapBase64(a.content),
    );
  }
  parts.push(`--${boundaryMixed}--`, "");
  return parts.join(CRLF);
}
