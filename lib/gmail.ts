const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

let tokenCache: { token: string; expiresAt: number } | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} belum di-set.`);
  return v;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const hint =
      data.error === "invalid_grant"
        ? " Refresh token kedaluwarsa/dicabut. Jalankan ulang `npm run token` lalu perbarui GOOGLE_REFRESH_TOKEN di Vercel. (Jika OAuth app masih status 'Testing', token kedaluwarsa tiap 7 hari — ubah ke 'In production'.)"
        : "";
    throw new Error(`Gagal mendapatkan access token Google: ${data.error ?? res.status} ${data.error_description ?? ""}.${hint}`);
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

async function gmail<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface DraftRef {
  id: string;
  message: { id: string; threadId: string; labelIds?: string[] };
}

export function draftLink(messageId: string) {
  return `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}`;
}

export async function createDraft(rawMime: string): Promise<DraftRef> {
  return gmail<DraftRef>(`${UPLOAD}/drafts?uploadType=media`, {
    method: "POST",
    headers: { "Content-Type": "message/rfc822" },
    body: rawMime,
  });
}

export async function updateDraft(draftId: string, rawMime: string): Promise<DraftRef> {
  return gmail<DraftRef>(`${UPLOAD}/drafts/${encodeURIComponent(draftId)}?uploadType=media`, {
    method: "PUT",
    headers: { "Content-Type": "message/rfc822" },
    body: rawMime,
  });
}

export async function deleteDraft(draftId: string): Promise<void> {
  await gmail<void>(`${API}/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
}

interface MessagePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}
interface FullMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MessagePart;
}

function header(msg: FullMessage, name: string) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function collect(part: MessagePart | undefined, out: { text?: string; files: string[] }) {
  if (!part) return out;
  if (part.filename) out.files.push(part.filename);
  else if (part.mimeType === "text/plain" && part.body?.data && !out.text) {
    out.text = Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  part.parts?.forEach((p) => collect(p, out));
  return out;
}

function summarize(msg: FullMessage, withBody = false) {
  const extra = withBody ? collect(msg.payload, { files: [] }) : null;
  return {
    message_id: msg.id,
    to: header(msg, "To"),
    cc: header(msg, "Cc"),
    subject: header(msg, "Subject"),
    tanggal: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, "Date"),
    cuplikan: msg.snippet,
    ...(extra ? { isi: extra.text, lampiran: extra.files } : {}),
  };
}

export async function listDrafts(query: string | undefined, max: number) {
  const params = new URLSearchParams({ maxResults: String(max) });
  if (query) params.set("q", query);
  const list = await gmail<{ drafts?: { id: string; message: { id: string } }[] }>(`${API}/drafts?${params}`);
  const drafts = list.drafts ?? [];
  return Promise.all(
    drafts.map(async (d) => {
      const full = await gmail<{ id: string; message: FullMessage }>(
        `${API}/drafts/${d.id}?format=metadata`,
      );
      return { draft_id: d.id, link: draftLink(full.message.id), ...summarize(full.message) };
    }),
  );
}

export async function getDraft(draftId: string) {
  const full = await gmail<{ id: string; message: FullMessage }>(`${API}/drafts/${encodeURIComponent(draftId)}?format=full`);
  return { draft_id: full.id, link: draftLink(full.message.id), ...summarize(full.message, true) };
}

export async function searchMessages(query: string, max: number) {
  const params = new URLSearchParams({ q: query, maxResults: String(max) });
  const list = await gmail<{ messages?: { id: string }[] }>(`${API}/messages?${params}`);
  return Promise.all(
    (list.messages ?? []).map(async (m) => {
      const full = await gmail<FullMessage>(
        `${API}/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Cc`,
      );
      return { ...summarize(full), from: header(full, "From"), label: full.labelIds };
    }),
  );
}

let labelIdCache: Record<string, string> = {};

async function ensureLabel(name: string): Promise<string> {
  if (labelIdCache[name]) return labelIdCache[name];
  const { labels = [] } = await gmail<{ labels?: { id: string; name: string }[] }>(`${API}/labels`);
  let found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    found = await gmail<{ id: string; name: string }>(`${API}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
  }
  labelIdCache[name] = found.id;
  return found.id;
}

/** Pasang label ke pesan draft. Tidak fatal bila gagal. */
export async function labelMessage(messageId: string, labelName: string): Promise<string | null> {
  try {
    const id = await ensureLabel(labelName);
    await gmail(`${API}/messages/${messageId}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [id] }),
    });
    return null;
  } catch (e) {
    labelIdCache = {};
    return (e as Error).message;
  }
}
