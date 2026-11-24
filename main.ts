// news-image-20261124 — a one-day newspaper infographic for Tuesday 24 November 2026.
// Every pixel is drawn with vector strokes into an RGB buffer and encoded as a PNG.
// Node's standard library only. Nothing is read from disk, the clock, or the network,
// so repeated runs produce identical bytes. Run: MAKEFUN_OUTPUT_DIR=out node main.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ------------------------------------------------------------------ PNG writer
// CRC-32 (IEEE) lookup table, built once when the module loads.
function makeCrc() {
  const tab = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    let k = 0;
    while (k < 8) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      k++;
    }
    tab[i] = c;
  }
  return tab;
}
const CRC_TAB = makeCrc();

function crc32(buf) {
  let sum = 0xffffffff;
  for (let p = 0; p < buf.length; p++) {
    sum = CRC_TAB[(sum ^ buf[p]) & 0xff] ^ (sum >>> 8);
  }
  return (sum ^ 0xffffffff) >>> 0;
}

function chunkBytes(kind, payload) {
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  out.write(kind, 4, "ascii");
  payload.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(kind, "ascii"), payload]);
  out.writeUInt32BE(crc32(crcInput), payload.length + 8);
  return out;
}

// True-colour PNG (8-bit RGB, filter 0 on every scanline) from a raw RGB buffer.
function pngEncode(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkBytes("IHDR", ihdr),
    chunkBytes("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunkBytes("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ raster
class Raster {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.buf[i * 3] = bg[0];
      this.buf[i * 3 + 1] = bg[1];
      this.buf[i * 3 + 2] = bg[2];
    }
  }

  set(x, y, c) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }

  box(x, y, w, h, c) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.w + xx) * 3;
        this.buf[i] = c[0];
        this.buf[i + 1] = c[1];
        this.buf[i + 2] = c[2];
      }
    }
  }

  // Filled circle, the stamp used for thick strokes.
  disc(cx, cy, r, c) {
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.set(x, y, c);
      }
    }
  }

  // Thick straight segment, stamped as overlapping discs.
  stroke(x0, y0, x1, y1, w, c) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const n = Math.max(2, Math.round(len / 1.2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.disc(x0 + dx * t, y0 + dy * t, w / 2, c);
    }
  }

  // Open polyline through [x, y] points.
  poly(points, w, c) {
    for (let i = 0; i + 1 < points.length; i++) {
      this.stroke(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], w, c);
    }
  }
}

// ------------------------------------------------------------------ typeface
// Vector face on a 96-unit em: cap top y=8, x-height top y=34, baseline y=76,
// descender floor y=94. A glyph is [advance, [stroke, ...]] where each stroke is
// a string of space-separated "x,y" points, drawn as one open polyline.
// Design notes: 'm' has flat crowns with the middle stem at crown height; 'f' has
// a candy-cane hook (up, over the top, down the left side) plus a long crossbar;
// 'y' has a descender that curls left and back up; 't' is a plain straight stem
// with a flat top and no hook; 'i' has a closed diamond dot, big enough to read;
// every stroke stays inside its advance and left bearings stay small.
const GLYPHS = {};
function add(ch, adv, strokes) {
  GLYPHS[ch] = { adv, strokes };
}
function glyphFor(ch) {
  const g = GLYPHS[ch];
  if (!g) throw new Error("no glyph for " + JSON.stringify(ch));
  return g;
}
function parseStroke(s) {
  return s.split(" ").map((pair) => pair.split(",").map(Number));
}

// lowercase
add("a", 58, ["48,76 48,44 40,38 26,36 14,40 10,54 14,70 26,76 40,76 48,70"]);
add("b", 56, ["14,76 14,8", "14,46 28,38 42,44 46,58 40,72 26,76 14,70"]);
add("c", 54, ["46,42 34,36 20,40 12,52 14,68 26,76 40,76 48,68"]);
add("d", 58, ["14,46 28,38 42,44 46,58 40,72 26,76 14,70", "46,76 46,8"]);
add("e", 56, ["46,56 42,40 30,36 16,42 12,56 16,70 28,76 42,74 48,66", "12,56 48,56"]);
add("f", 52, ["40,76 40,14 30,6 18,6 12,14 12,28", "6,46 50,46"]);
add("g", 58, ["48,42 34,36 20,40 12,52 14,68 26,76 40,76 48,68", "48,68 48,88 42,94 28,94 20,88"]);
add("h", 56, ["12,76 12,8", "12,48 28,36 42,42 44,54 44,76"]);
add("i", 28, ["14,76 14,42", "14,14 19,22 14,30 9,22 14,14"]);
add("j", 30, ["16,42 16,84 12,92 4,92", "16,14 21,22 16,30 11,22 16,14"]);
add("k", 54, ["12,76 12,8", "12,52 40,36", "26,46 44,76"]);
add("l", 28, ["14,76 14,8"]);
add("m", 88, ["8,76 8,34 26,34 44,34 44,76", "44,34 62,34 80,34 80,76"]);
add("n", 56, ["10,76 10,34 28,34 46,34 46,76"]);
add("o", 56, ["28,36 14,44 10,58 14,70 28,76 42,74 50,62 48,46 40,38 28,36"]);
add("p", 56, ["14,34 14,94", "14,46 28,38 42,44 46,58 40,72 26,76 14,70"]);
add("q", 58, ["14,46 28,38 42,44 46,58 40,72 26,76 14,70", "46,70 46,94"]);
add("r", 42, ["12,76 12,34", "12,34 28,34 38,42 38,52"]);
add("s", 54, ["46,42 34,36 20,40 14,50 20,60 36,62 46,70 42,76 28,78 14,74"]);
add("t", 42, ["26,76 26,12", "10,34 42,34"]);
add("u", 56, ["10,34 10,62 18,74 32,76 44,70 48,58 48,34"]);
add("v", 54, ["6,34 26,76 46,34"]);
add("w", 66, ["6,34 20,76 34,52 48,76 62,34"]);
add("x", 54, ["8,34 48,76", "48,34 8,76"]);
add("y", 54, ["6,34 26,68 46,34", "26,68 26,88 18,94 8,88 6,78"]);
add("z", 54, ["8,34 48,34 8,76 48,76"]);
// digits
add("0", 62, ["30,8 14,16 8,36 10,60 22,74 40,76 54,62 56,36 46,16 30,8"]);
add("1", 36, ["16,18 28,8 28,76 14,76"]);
add("2", 58, ["12,26 20,10 38,8 50,20 50,32 14,76 50,76"]);
add("3", 58, ["14,14 34,6 48,16 48,30 38,42 46,48 48,60 38,74 18,76"]);
add("4", 60, ["40,8 14,56 50,56", "40,8 40,76"]);
add("5", 58, ["48,8 14,8 14,42 32,42 48,50 48,64 36,76 18,76"]);
add("6", 60, ["46,16 32,8 18,18 12,36 14,60 26,76 42,76 52,62 50,46 38,40"]);
add("7", 56, ["10,8 50,8 30,76"]);
add("8", 60, ["30,8 17,14 12,28 18,42 30,44 42,42 48,28 42,14 30,8", "25,44 13,52 11,66 21,76 35,76 49,66 47,52 37,44"]);
add("9", 60, ["16,66 28,74 44,64 50,46 48,24 38,10 22,10 12,22 14,38 26,44"]);
// capitals
add("A", 66, ["6,76 34,8 62,76", "18,54 50,54"]);
add("B", 60, ["12,76 12,8", "12,8 38,8 50,20 50,34 38,42 12,42", "12,42 40,42 52,52 52,66 40,76 12,76"]);
add("C", 60, ["52,22 40,10 22,12 12,28 12,58 22,74 40,76 52,64"]);
add("D", 64, ["12,76 12,8", "12,8 38,8 56,22 56,58 38,76 12,76"]);
add("E", 56, ["12,76 12,8", "12,8 48,8", "12,42 40,42", "12,76 48,76"]);
add("F", 54, ["12,76 12,8", "12,8 48,8", "12,44 38,44"]);
add("G", 64, ["54,26 42,12 24,12 12,28 12,58 22,74 40,76 54,64 54,48 36,48"]);
add("H", 64, ["12,76 12,8", "54,76 54,8", "12,42 54,42"]);
add("I", 34, ["8,8 26,8", "17,8 17,76", "8,76 26,76"]);
add("J", 54, ["46,8 46,62 38,74 20,74 12,66"]);
add("K", 62, ["12,76 12,8", "12,48 52,8", "28,38 52,76"]);
add("L", 54, ["12,76 12,8", "12,76 50,76"]);
add("M", 76, ["8,76 8,8 38,46 68,8 68,76"]);
add("N", 68, ["10,76 10,8 60,76 60,8"]);
add("O", 68, ["34,8 15,16 9,34 11,58 23,72 43,74 57,60 59,34 49,16 34,8"]);
add("P", 58, ["12,76 12,8", "12,8 38,8 52,20 52,34 40,44 12,44"]);
add("Q", 68, ["34,8 15,16 9,34 11,58 23,72 43,74 57,60 59,34 49,16 34,8", "46,58 60,76"]);
add("R", 60, ["12,76 12,8", "12,8 38,8 52,20 52,34 40,44 12,44", "30,42 54,76"]);
add("S", 58, ["50,20 38,8 22,10 14,22 18,36 32,44 48,50 52,62 44,72 28,76 14,68"]);
add("T", 60, ["8,8 54,8", "31,8 31,76"]);
add("U", 64, ["10,8 10,58 20,72 42,74 54,60 54,8"]);
add("V", 64, ["6,8 32,76 58,8"]);
add("W", 90, ["6,8 18,76 32,44 46,76 60,44 74,76 86,8"]);
add("X", 62, ["8,8 56,76", "56,8 8,76"]);
add("Y", 62, ["6,8 32,42 58,8", "32,42 32,76"]);
add("Z", 60, ["8,8 54,8 8,76 54,76"]);
// punctuation and symbols
add(".", 28, ["12,68 19,68 19,76 12,76 12,68"]);
add(",", 30, ["12,68 19,68 19,76 12,76 12,68", "17,76 12,90"]);
add(":", 28, ["12,40 19,40 19,48 12,48 12,40", "12,62 19,62 19,70 12,70 12,62"]);
add(";", 30, ["12,32 19,32 19,40 12,40 12,32", "12,62 19,62 19,70 12,70 12,62", "17,70 12,86"]);
add("’", 24, ["14,8 10,24"]);
add("‘", 24, ["10,8 14,24"]);
add("'", 24, ["15,6 8,26"]);
add("-", 42, ["8,48 36,48"]);
add("—", 66, ["6,48 62,48"]);
add("·", 28, ["12,44 19,44 19,52 12,52 12,44"]);
add("$", 62, ["48,20 34,8 18,12 12,24 16,38 30,44 46,48 52,60 46,70 30,76 14,70", "31,2 31,86"]);
add(" ", 28, []);

// ------------------------------------------------------------------ text engine
function stringWidth(text, size) {
  let total = 0;
  for (const ch of text) total += (glyphFor(ch).adv * size) / 96;
  return total;
}

// Draw a string left-aligned at (x, baselineY). Returns the x where it ends.
function drawString(r, x, baselineY, text, size, color, weight = 0.115) {
  const scale = size / 96;
  const w = Math.max(1, size * weight);
  let cursor = x;
  for (const ch of text) {
    const g = glyphFor(ch);
    for (const s of g.strokes) {
      const pts = parseStroke(s).map(([px, py]) => [cursor + px * scale, baselineY + (py - 76) * scale]);
      r.poly(pts, w, color);
    }
    cursor += (g.adv * size) / 96;
  }
  return cursor;
}

function wrapText(text, size, maxW) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const trial = current ? current + " " + word : word;
    if (stringWidth(trial, size) <= maxW) {
      current = trial;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function drawPara(r, x, y, text, size, leading, maxW, color) {
  const lines = wrapText(text, size, maxW);
  lines.forEach((line, i) => drawString(r, x, y + i * leading, line, size, color));
  return lines.length;
}

function drawCentered(r, y, text, size, color, weight = 0.115) {
  drawString(r, (1024 - stringWidth(text, size)) / 2, y, text, size, color, weight);
}

function drawCenteredIn(r, cx, y, text, size, color, weight = 0.115) {
  drawString(r, cx - stringWidth(text, size) / 2, y, text, size, color, weight);
}

function drawKicker(r, x, y, text, size = 14) {
  r.box(x, y - size + 3, size - 3, size - 3, RED);
  drawString(r, x + size + 5, y, text, size, RED, 0.13);
}

// ------------------------------------------------------------------ palette
const PAPER = [248, 242, 224];
const INK = [22, 22, 22];
const RED = [158, 28, 28];
const NAVY = [30, 58, 88];
const SKY = [84, 128, 178];
const PALE = [216, 230, 242];
const GREY = [104, 104, 94];
const WHITE = [250, 250, 250];
const MIDBLUE = [52, 88, 128];

// ------------------------------------------------------------------ page layout
const W = 1024;
const H = 1024;
const ML = 36;
const MR = 988;

function renderPage() {
  const r = new Raster(W, H, PAPER);

  // Top double rule and masthead.
  r.box(ML, 24, MR - ML, 4, INK);
  r.box(ML, 32, MR - ML, 2, INK);
  drawCentered(r, 80, "THE WORLD IN ONE DAY", 46, RED, 0.13);

  // Two-line headline.
  drawString(r, ML, 152, "Youngest title match ever", 60, INK, 0.12);
  drawString(r, ML, 220, "opens tonight in Geneva", 60, INK, 0.12);

  // Dateline with red rules on both sides.
  const dateText = "TUESDAY, 24 NOVEMBER 2026";
  const dateW = stringWidth(dateText, 21);
  r.box(ML, 249, 512 - dateW / 2 - 18 - ML, 2, RED);
  r.box(512 + dateW / 2 + 18, 249, MR - (512 + dateW / 2 + 18), 2, RED);
  drawString(r, 512 - dateW / 2, 258, dateText, 21, INK, 0.12);

  // Deck, wrapped to the full width.
  drawPara(
    r, ML, 292,
    "Gukesh defends his crown against Sindarov in Game 1 at 21:00 WIB. Both are 20. Sindarov has White; the champion takes Black.",
    19, 26, MR - ML, GREY
  );
  r.box(ML, 333, MR - ML, 2, INK);

  // ---- lead block: chess panel on the left, text on the right ----
  const px = 36;
  const py = 350;
  const pw = 416;
  const ph = 262;
  r.box(px, py, pw, ph, NAVY);
  // Chessboard, 8x8 cells of 13 px.
  const bx = px + 28;
  const by = py + 24;
  const sq = 13;
  r.box(bx - 2, by - 2, 8 * sq + 4, 8 * sq + 4, INK);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 0) r.box(bx + col * sq, by + row * sq, sq, sq, PALE);
      else r.box(bx + col * sq, by + row * sq, sq, sq, MIDBLUE);
    }
  }
  // Two pieces: a white king on a dark square, a black king on a light square.
  r.disc(bx + 4 * sq + 6, by + 5 * sq + 6, 6.5, INK);
  r.disc(bx + 4 * sq + 6, by + 5 * sq + 6, 5, WHITE);
  r.disc(bx + 2 * sq + 6, by + 2 * sq + 6, 6.5, PALE);
  r.disc(bx + 2 * sq + 6, by + 2 * sq + 6, 5, INK);
  // Game label to the right of the board.
  drawString(r, px + 154, py + 52, "GAME 1", 34, WHITE, 0.12);
  drawString(r, px + 154, py + 92, "TONIGHT", 34, WHITE, 0.12);
  // Red banner with the colour draw.
  r.box(px, py + 156, pw, 46, RED);
  drawCenteredIn(r, px + pw / 2, py + 186, "SINDAROV WHITE · GUKESH BLACK", 20, PAPER, 0.13);
  drawCenteredIn(r, px + pw / 2, py + 236, "21:00 WIB · GENEVA · $2.5M PRIZE", 14, PALE, 0.12);

  // Right column: kicker, subhead, body.
  drawKicker(r, 484, 372, "CHESS · GENEVA", 15);
  drawString(r, 484, 414, "Two 20-year-olds, one crown", 30, INK, 0.12);
  drawPara(
    r, 484, 446,
    "Defending champion Gukesh Dommaraju meets challenger Javokhir Sindarov in the first game of the world championship tonight at the Fondation Martin Bodmer in Geneva. Sindarov, the world No. 4, has the white pieces after the colour draw; Gukesh, 18 when he won the title in Singapore, starts with Black. Fourteen classical games, first to 7.5 points, for a $2.5 million prize fund.",
    16, 21, 504, INK
  );

  r.box(ML, 627, MR - ML, 2, INK);

  // ---- 2x2 grid of supporting stories ----
  r.box(511, 644, 2, 236, INK);
  r.box(ML, 757, MR - ML, 2, INK);
  function gridCell(x, top, kick, head, body) {
    drawKicker(r, x, top + 22, kick, 13);
    drawString(r, x, top + 54, head, 21, INK, 0.12);
    drawPara(r, x, top + 76, body, 14, 18, 460, INK);
  }
  gridCell(
    36, 628, "THE GULF · HORMUZ", "IRGC claims three tankers hit mines",
    "Iran's Revolutionary Guard said three oil tankers caught fire after hitting naval mines in the Strait of Hormuz, despite a US Navy escort. The claim is unverified; oil held near $89."
  );
  gridCell(
    528, 628, "EUROPE · ESTONIA", "Russia warns Estonia of 'open war'",
    "Moscow accused Estonia of acts 'on the verge of triggering open war' after Tallinn said it will shut its border with Russia from 1 December, blaming Russian agents for arson."
  );
  gridCell(
    36, 758, "TECH · NVIDIA", "Nvidia brings Huang back",
    "Nvidia reinstated Jensen Huang as chief executive, 11 days after he resigned, after direct pressure from President Trump. Shares jumped by about a third; the US blacklisted a Singapore chip firm."
  );
  gridCell(
    528, 758, "US · AI", "Two states sue SpaceX over Grok",
    "Virginia and Oregon sued Elon Musk's SpaceX, the first states to sue over Grok's image tool, saying it made child sexual abuse material and other non-consensual images."
  );

  r.box(ML, 889, MR - ML, 2, INK);

  // ---- also today ----
  drawKicker(r, ML, 916, "ALSO TODAY — 24 NOVEMBER 2026", 15);
  const also = [
    "Libya: Ukraine says its drones sank the Russian corvette Merkury off Benghazi; the UN is asked to investigate.",
    "Korea: Russian jets entered South Korea's air defence zone on Monday; Seoul issued an alert and scrambled jets.",
    "Gaza: Israeli strikes killed at least three people in Gaza, including a UN aid worker.",
  ];
  also.forEach((line, i) => {
    const y = 940 + i * 21;
    r.disc(42, y - 5, 3.5, RED);
    drawString(r, 56, y, line, 15, INK);
  });

  // ---- footer ----
  r.box(ML, 995, MR - ML, 2, INK);
  drawCentered(
    r, 1014,
    "24 November 2026 · Sources: Reuters, Chess.com, CNN, AP, AFP · A one-day summary, drawn from the day's reporting",
    12, GREY
  );
  return r;
}

// ------------------------------------------------------------------ run
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "entry.png");
const sheet = renderPage();
fs.writeFileSync(outFile, pngEncode(W, H, sheet.buf));
console.log("wrote", outFile, fs.statSync(outFile).size, "bytes");
