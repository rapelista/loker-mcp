import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/**
 * Render teks polos menjadi PDF A4 yang rapi (untuk cover letter / surat lamaran).
 * Format teks:
 *  - Paragraf dipisah baris kosong; satu baris baru = pindah baris.
 *  - Baris yang diawali "# " dicetak tebal & lebih besar (judul).
 *  - Baris yang seluruhnya "**teks**" dicetak tebal.
 */

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = { x: 64, top: 64, bottom: 64 };
const SIZE = 11;
const LEADING = 16;
const PARA_GAP = 8;

// Font standar PDF hanya mendukung WinAnsi; ganti karakter tipografis umum.
const REPLACE: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", "…": "...", " ": " ",
  "•": "-", "→": "->", "\t": "    ",
};

function sanitize(text: string, font: PDFFont) {
  let out = "";
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const c = REPLACE[ch] ?? ch;
    if (c === "\n") {
      out += c;
      continue;
    }
    try {
      font.encodeText(c);
      out += c;
    } catch {
      // karakter di luar WinAnsi (emoji, aksara non-Latin) dilewati
    }
  }
  return out;
}

function wrap(line: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!line) return [""];
  const words = line.split(/ +/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      cur = test;
      continue;
    }
    if (cur) lines.push(cur);
    // kata yang lebih panjang dari satu baris (mis. URL) dipotong paksa
    let rest = w;
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let i = rest.length;
      while (i > 1 && font.widthOfTextAtSize(rest.slice(0, i), size) > maxWidth) i--;
      lines.push(rest.slice(0, i));
      rest = rest.slice(i);
    }
    cur = rest;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function textToPdf(text: string, title?: string, author?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  if (author) doc.setAuthor(author);
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const maxWidth = A4.w - MARGIN.x * 2;

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN.top;
  const ensure = (h: number) => {
    if (y - h < MARGIN.bottom) {
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - MARGIN.top;
    }
  };

  const paragraphs = sanitize(text, regular).trim().split(/\n{2,}/);
  paragraphs.forEach((para, pi) => {
    for (const raw of para.split("\n")) {
      let font = regular;
      let size = SIZE;
      let line = raw.trimEnd();
      if (line.startsWith("# ")) {
        font = bold;
        size = 14;
        line = line.slice(2);
      } else if (/^\*\*.+\*\*$/.test(line.trim())) {
        font = bold;
        line = line.trim().slice(2, -2);
      }
      const leading = size === SIZE ? LEADING : size + 6;
      for (const l of wrap(line, font, size, maxWidth)) {
        ensure(leading);
        y -= leading;
        page.drawText(l, { x: MARGIN.x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      }
    }
    if (pi < paragraphs.length - 1) y -= PARA_GAP;
  });

  return Buffer.from(await doc.save());
}
