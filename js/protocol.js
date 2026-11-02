// iPixel-Color-BLE-Protokoll (Port von pypixelcolor 0.5, MIT).
// Reine Byte-Funktionen ohne Browser-Abhängigkeiten.

export const WRITE_UUID = "0000fa02-0000-1000-8000-00805f9b34fb";
export const NOTIFY_UUID = "0000fa03-0000-1000-8000-00805f9b34fb";

const WINDOW_SIZE = 12 * 1024;

// ---------------------------------------------------------------- CRC32 (wie binascii.crc32)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u16le = (v) => [v & 0xff, (v >>> 8) & 0xff];

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- Plans
// Ein Plan = Liste von Fenstern + ACK-Verhalten (wie SendPlan in Python).
export function singleWindowPlan(id, data, { requiresAck = true, expectResponse = false } = {}) {
  return {
    id,
    windows: [{ data: Uint8Array.from(data), requiresAck }],
    ackPerWindow: requiresAck,
    ackFinal: false,
    expectResponse,
  };
}

function multiWindowPlan(id, windows) {
  return { id, windows, ackPerWindow: true, ackFinal: true, expectResponse: false };
}

// ---------------------------------------------------------------- Befehle
export function deviceInfoCommand(date = new Date()) {
  return singleWindowPlan("get_device_info", [
    8, 0, 1, 0x80, date.getHours(), date.getMinutes(), date.getSeconds(), 0,
  ], { requiresAck: false, expectResponse: true });
}

const DEVICE_TYPE_MAP = {
  128: 0, 129: 2, 130: 4, 131: 3, 132: 1, 133: 5, 134: 6, 135: 7, 136: 8, 137: 9,
  138: 10, 139: 11, 140: 12, 141: 13, 142: 14, 143: 15, 144: 16, 145: 17, 146: 18, 147: 19,
};
const LED_SIZE_MAP = {
  0: [64, 64], 1: [96, 16], 2: [32, 32], 3: [64, 16], 4: [32, 16], 5: [64, 20], 6: [128, 32],
  7: [144, 16], 8: [192, 16], 9: [48, 24], 10: [64, 32], 11: [96, 32], 12: [128, 32],
  13: [96, 32], 14: [160, 32], 15: [192, 32], 16: [256, 32], 17: [320, 32], 18: [384, 32],
  19: [448, 32],
};

export function parseDeviceInfo(resp) {
  if (resp.length < 5) throw new Error(`Antwort zu kurz (${resp.length} Bytes)`);
  const deviceType = resp[4];
  const ledType = DEVICE_TYPE_MAP[deviceType] ?? 0;
  const [width, height] = LED_SIZE_MAP[ledType] ?? [64, 64];
  return { deviceType, ledType, width, height, passwordFlag: resp.length >= 11 ? resp[10] : 255 };
}

export const brightnessCommand = (level) => {
  level = Math.round(level);
  if (level < 0 || level > 100) throw new Error("Helligkeit 0–100");
  return singleWindowPlan("set_brightness", [5, 0, 4, 0x80, level]);
};

export const powerCommand = (on) => singleWindowPlan("set_power", [5, 0, 7, 1, on ? 1 : 0]);

export function clockCommand({ style = 1, format24 = true, showDate = true, date = new Date() } = {}) {
  if (style < 0 || style > 8) throw new Error("Uhrstil 0–8");
  const dow = ((date.getDay() + 6) % 7) + 1; // Montag = 1 (wie Python weekday()+1)
  return singleWindowPlan("set_clock_mode", [
    11, 0, 6, 1, style & 0xff, format24 ? 1 : 0, showDate ? 1 : 0,
    date.getFullYear() % 100, date.getMonth() + 1, date.getDate(), dow,
  ]);
}

// ---------------------------------------------------------------- Bilder
// fileBytes: fertige GIF- bzw. PNG-Datei in Displaygröße.
export function imagePlan(fileBytes, isGif, saveSlot = 0) {
  const size = u32le(fileBytes.length);
  const crc = u32le(crc32(fileBytes));
  const windows = [];
  for (let pos = 0, idx = 0; pos < fileBytes.length; pos += WINDOW_SIZE, idx++) {
    const chunk = fileBytes.subarray(pos, Math.min(pos + WINDOW_SIZE, fileBytes.length));
    const option = idx === 0 ? 0x00 : 0x02;
    const header = isGif
      ? [0x03, 0x00, option, ...size, ...crc, 0x02, saveSlot]
      : [0x02, 0x00, option, ...size, ...crc, 0x00, saveSlot];
    const frame = concat(header, chunk);
    windows.push({ data: concat(u16le(2 + frame.length), frame), requiresAck: true });
  }
  return multiWindowPlan("send_image", windows);
}

// ---------------------------------------------------------------- Text
// Glyph-Bitmap (Zeilen von 0/1, Breite w) -> Bytes wie encode_char_img + Bitumkehr.
export function encodeGlyphBits(bits, w, h) {
  const bytesPerRow = w <= 8 ? 1 : w <= 16 ? 2 : w <= 24 ? 3 : 4;
  const out = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w && x < bytesPerRow * 8; x++) {
      if (bits[y * w + x]) out[y * bytesPerRow + (x >> 3)] |= 1 << (x & 7);
    }
  }
  return out;
}

export function characterBlock(glyphBytes, charHeight, color, charWidth) {
  const is32 = charHeight >= 32 ? 1 : 0;
  const isWide = charWidth > (is32 ? 16 : 8) ? 1 : 0;
  return concat([(is32 << 1) | isWide], color, glyphBytes);
}

export function emojiBlock(jpegBytes, charHeight) {
  const opcode = charHeight >= 32 ? 0x09 : 0x08;
  return concat([opcode, ...u16le(jpegBytes.length), 0x00], jpegBytes);
}

export function textProperties(animation, speed, rainbow, color, bgColor = null) {
  const p = [0x00, 0x01, 0x01, animation & 0xff, speed & 0xff, rainbow & 0xff, ...color];
  if (bgColor) p.push(0x01, ...bgColor); else p.push(0, 0, 0, 0);
  return p;
}

// blocks: bereits kodierte Zeichen-/Emoji-Blöcke, numChars: Anzahl Zeichen
export function textPlan(blocks, numChars, props, saveSlot = 0) {
  const payload = concat([numChars & 0xff], props, ...blocks);
  const size = u32le(payload.length);
  const crc = u32le(crc32(payload));
  const windows = [];
  for (let pos = 0, idx = 0; pos < payload.length; pos += WINDOW_SIZE, idx++) {
    const chunk = payload.subarray(pos, Math.min(pos + WINDOW_SIZE, payload.length));
    const option = idx === 0 ? 0x00 : 0x02;
    const frame = concat([0x00, 0x01, option, ...size, ...crc, 0x00, saveSlot & 0xff], chunk);
    windows.push({ data: concat(u16le(frame.length + 2), frame), requiresAck: true });
  }
  return multiWindowPlan("send_text", windows);
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Notify-Rahmen -> "window" | "final" | null (wie AckManager)
export function classifyAck(data) {
  if (!data || data.length < 5 || data[0] !== 0x05) return null;
  if (data[4] === 0 || data[4] === 1) return "window";
  if (data[4] === 3) return "final";
  return null;
}

// ---------------------------------------------------------------- Speicherplätze
export const showSlotCommand = (n) => singleWindowPlan("show_slot", [0x07, 0x00, 0x08, 0x80, 0x01, 0x00, n & 0xff]);
export function deleteSlotCommand(n) {
  if (n < 0 || n > 255) throw new Error("Slot 0–255");
  return singleWindowPlan("delete_slot", [7, 0, 2, 1, 1, 0, n & 0xff]);
}
