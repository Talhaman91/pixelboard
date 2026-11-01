// Bildverarbeitung im Browser: dekodieren, auf Displaygröße bringen, GIF/PNG erzeugen,
// außerdem Text-Glyphen und Emoji-Blöcke für den Textbefehl.
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";
import { encodeGlyphBits, characterBlock, emojiBlock } from "./protocol.js";

const MAX_DECODE_FRAMES = 400;

function canvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function canvasToBytes(c, type, quality) {
  const blob = c.convertToBlob
    ? await c.convertToBlob({ type, quality })
    : await new Promise((r) => c.toBlob(r, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// -> { frames: [{ src, duration }], width, height }  (src: VideoFrame oder ImageBitmap)
export async function decode(blob) {
  const type = blob.type || "image/gif";
  if (typeof ImageDecoder !== "undefined" && (await ImageDecoder.isTypeSupported(type).catch(() => false))) {
    try {
      const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      await dec.completed.catch(() => {});
      const count = Math.min(track ? track.frameCount : 1, MAX_DECODE_FRAMES) || 1;
      const frames = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        frames.push({ src: image, duration: image.duration ? image.duration / 1000 : 100 });
      }
      dec.close();
      const f0 = frames[0].src;
      return { frames, width: f0.displayWidth, height: f0.displayHeight };
    } catch (e) {
      console.warn("ImageDecoder fehlgeschlagen, nutze Standbild", e);
    }
  }
  const bmp = await createImageBitmap(blob);
  return { frames: [{ src: bmp, duration: 100 }], width: bmp.width, height: bmp.height };
}

// Mehrere Einzelbilder (z. B. Sprite-Frames) -> wie decode()
export async function decodeFrames(blobs, frameMs = 100) {
  const bmps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
  const width = Math.max(...bmps.map((b) => b.width));
  const height = Math.max(...bmps.map((b) => b.height));
  return { frames: bmps.map((b) => ({ src: b, duration: frameMs })), width, height };
}

// Gemeinsamer Rahmen aller nicht-transparenten Pixel über alle Frames
function opaqueBounds(frames, w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const f of frames) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(f.src, 0, 0);
    const a = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a[(y * w + x) * 4 + 3] > 16) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropFrames(frames, r) {
  return frames.map((f) => {
    const c = canvas(r.w, r.h);
    c.getContext("2d").drawImage(f.src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return { src: c, duration: f.duration, orig: f.src };
  });
}

export function releaseFrames(decoded) {
  for (const f of decoded.frames) try { (f.orig || f.src).close?.(); } catch { /* egal */ }
}

// Ein Frame auf w×h bringen (schwarzer Hintergrund wie im Original).
function renderFrame(src, sw, sh, w, h, mode, pixelart) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const scale = mode === "fit" ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const small = sw <= w * 2 && sh <= h * 2;
  let source = src, ssw = sw, ssh = sh;
  if (!(pixelart && small) && (sw > dw * 2 || sh > dh * 2)) {
    // stufenweise verkleinern = deutlich weichere Ergebnisse bei großen Bildern
    while (ssw > dw * 2 || ssh > dh * 2) {
      const nw = Math.max(dw, Math.floor(ssw / 2)), nh = Math.max(dh, Math.floor(ssh / 2));
      const tmp = canvas(nw, nh);
      const tctx = tmp.getContext("2d");
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(source, 0, 0, ssw, ssh, 0, 0, nw, nh);
      source = tmp; ssw = nw; ssh = nh;
    }
  }
  ctx.imageSmoothingEnabled = !(pixelart && small);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, ssw, ssh, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  return { canvas: c, data: ctx.getImageData(0, 0, w, h) };
}

// -> { bytes: Uint8Array, isGif, frames, mime }
export async function render(input, { width = 32, height = 32, mode = "crop", pixelart = false, maxFrames = 64, frameMs = 100, trim = pixelart, minFrameMs = 0 } = {}) {
  const dec = Array.isArray(input) ? await decodeFrames(input, frameMs) : await decode(input);
  try {
    if (trim) {
      const r = opaqueBounds(dec.frames, dec.width, dec.height);
      // nur bei viel leerem Rand (z. B. 16×28-Figuren), damit 16×16-Icons exakt 2× skaliert bleiben
      if (r && r.w * r.h < 0.75 * dec.width * dec.height) {
        dec.frames = cropFrames(dec.frames, r);
        dec.width = r.w; dec.height = r.h;
      }
    }
    let frames = dec.frames;
    let durations = frames.map((f) => Math.max(20, Math.round(f.duration || 100)));
    // Bildrate begrenzen: zu schnelle Frames zusammenfassen, Gesamtdauer bleibt gleich
    if (minFrameMs > 0 && frames.length > 1) {
      const kf = [], kd = [];
      frames.forEach((f, i) => {
        if (kf.length && kd[kd.length - 1] < minFrameMs) kd[kd.length - 1] += durations[i];
        else { kf.push(f); kd.push(durations[i]); }
      });
      frames = kf; durations = kd;
    }
    if (frames.length > maxFrames) {
      const step = frames.length / maxFrames;
      const idx = Array.from({ length: maxFrames }, (_, i) => Math.floor(i * step));
      const bounds = [...idx, frames.length];
      durations = idx.map((_, i) => durations.slice(bounds[i], bounds[i + 1]).reduce((a, b) => a + b, 0));
      frames = idx.map((i) => frames[i]);
    }
    if (frames.length === 1) {
      const { canvas: c } = renderFrame(frames[0].src, dec.width, dec.height, width, height, mode, pixelart);
      return { bytes: await canvasToBytes(c, "image/png"), isGif: false, frames: 1, mime: "image/png" };
    }
    // Alle Frames rendern und EINE gemeinsame Palette bilden (spart 768 Byte pro Frame)
    const datas = frames.map((f) => renderFrame(f.src, dec.width, dec.height, width, height, mode, pixelart).data.data);
    const all = new Uint8ClampedArray(datas.reduce((n, d) => n + d.length, 0));
    datas.reduce((o, d) => { all.set(d, o); return o + d.length; }, 0);
    const palette = quantize(all, 256, { format: "rgb565" });
    const gif = GIFEncoder();
    datas.forEach((d, i) => {
      const index = applyPalette(d, palette, "rgb565");
      gif.writeFrame(index, width, height, i === 0
        ? { palette, delay: durations[i], repeat: 0, dispose: 2 }
        : { delay: durations[i], dispose: 2 });
    });
    gif.finish();
    const total = durations.reduce((a, b) => a + b, 0);
    return { bytes: gif.bytes(), isGif: true, frames: frames.length, fps: frames.length / (total / 1000), mime: "image/gif" };
  } finally {
    releaseFrames(dec);
  }
}

// ---------------------------------------------------------------- Text

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function glyphBits(ch, h, font) {
  const half = h >= 32 ? 16 : 8;
  const full = h >= 32 ? 32 : 16;
  const probe = canvas(full * 2, h).getContext("2d");
  probe.font = font;
  const tw = probe.measureText(ch).width;
  const slot = WIDE_RE.test(ch) || tw > half * 1.25 ? full : half;
  const c = canvas(slot, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, slot, h);
  ctx.fillStyle = "#fff";
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(ch, slot / 2, h / 2 + 1);
  const px = ctx.getImageData(0, 0, slot, h).data;
  const bits = new Uint8Array(slot * h);
  for (let i = 0; i < bits.length; i++) bits[i] = px[i * 4] > 128 ? 1 : 0;
  return { bits, slot };
}

async function emojiJpeg(ch, h) {
  const cps = Array.from(ch).map((c) => c.codePointAt(0).toString(16)).filter((x) => x !== "fe0f");
  const url = `https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72/${cps.join("-")}.png`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const c = canvas(h, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, h, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, h, h);
  bmp.close();
  let jpg = await canvasToBytes(c, "image/jpeg", 0.95);
  const preview = ctx.getImageData(0, 0, h, h);
  if (jpg[2] === 0xff && jpg[3] === 0xe0) {
    // JFIF-Kopf entfernen wie die Original-App (SOI + ab DQT)
    for (let i = 4; i < jpg.length - 1; i++) {
      if (jpg[i] === 0xff && jpg[i + 1] === 0xdb) {
        const out = new Uint8Array(2 + jpg.length - i);
        out[0] = 0xff; out[1] = 0xd8; out.set(jpg.subarray(i), 2);
        jpg = out;
        break;
      }
    }
  }
  return { jpg, preview };
}

// Text -> { blocks, count, preview } für protocol.textPlan
export async function encodeText(text, { height = 32, color = [255, 255, 255], font = "bold 26px system-ui, sans-serif", reverse = false } = {}) {
  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter() : null;
  let chars = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  if (reverse) chars = chars.reverse();
  const blocks = [];
  const preview = [];
  for (const ch of chars) {
    if (EMOJI_RE.test(ch)) {
      const em = await emojiJpeg(ch, height).catch(() => null);
      if (em) { blocks.push(emojiBlock(em.jpg, height)); preview.push({ image: em.preview }); }
      continue;
    }
    const { bits, slot } = glyphBits(ch, height, font);
    blocks.push(characterBlock(encodeGlyphBits(bits, slot, height), height, color, slot));
    preview.push({ bits, slot });
  }
  return { blocks, count: blocks.length, preview };
}
