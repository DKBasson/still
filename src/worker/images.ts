import { LIMITS } from "../shared/domain";

export type ProcessedImage = {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

export function processImage(input: Uint8Array, maxBytes: number): ProcessedImage {
  if (input.byteLength === 0) throw new ImageRejected("Choose an image file.");
  if (input.byteLength > maxBytes) throw new ImageRejected("That image is larger than the upload limit.");
  if (isJpeg(input)) return finish("image/jpeg", stripJpeg(input));
  if (isPng(input)) return finish("image/png", stripPng(input));
  if (isWebp(input)) return finish("image/webp", stripWebp(input));
  throw new ImageRejected("Use a JPEG, PNG, or WebP photograph.");
}

function finish(contentType: ProcessedImage["contentType"], image: { bytes: Uint8Array; width: number; height: number }): ProcessedImage {
  if (image.width < 1 || image.height < 1 || image.width > LIMITS.maxDimension || image.height > LIMITS.maxDimension) {
    throw new ImageRejected("That image's dimensions are not supported.");
  }
  return { bytes: image.bytes, contentType, width: image.width, height: image.height };
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length > 12 && readFour(bytes, 0) === "RIFF" && readFour(bytes, 8) === "WEBP";
}

function stripJpeg(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const out: number[] = [0xff, 0xd8];
  let width = 0;
  let height = 0;
  let i = 2;
  let sawScan = false;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new ImageRejected("The JPEG file is not valid.");
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) break;
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(0xff, marker);
      continue;
    }
    if (i + 1 >= bytes.length) throw new ImageRejected("The JPEG file is not valid.");
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) throw new ImageRejected("The JPEG file is not valid.");
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length >= 7) {
        height = (bytes[i + 3] << 8) | bytes[i + 4];
        width = (bytes[i + 5] << 8) | bytes[i + 6];
      }
    }
    if (!isApp && !isComment) {
      out.push(0xff, marker);
      for (let n = 0; n < length; n += 1) out.push(bytes[i + n]);
    }
    i += length;
    if (marker === 0xda) {
      sawScan = true;
      while (i < bytes.length) {
        out.push(bytes[i]);
        i += 1;
      }
      break;
    }
  }
  if (!sawScan || width < 1 || height < 1) throw new ImageRejected("The JPEG file is not valid.");
  if (out[out.length - 2] !== 0xff || out[out.length - 1] !== 0xd9) out.push(0xff, 0xd9);
  return { bytes: Uint8Array.from(out), width, height };
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs"]);

function stripPng(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const signature = bytes.slice(0, 8);
  const chunks: Uint8Array[] = [signature];
  let width = 0;
  let height = 0;
  let i = 8;
  let sawIend = false;
  let sawIdat = false;
  while (i + 12 <= bytes.length) {
    const length = readU32be(bytes, i);
    const type = readFour(bytes, i + 4);
    const end = i + 12 + length;
    if (end > bytes.length) throw new ImageRejected("The PNG file is not valid.");
    if (type === "IHDR") {
      if (length < 8) throw new ImageRejected("The PNG file is not valid.");
      width = readU32be(bytes, i + 8);
      height = readU32be(bytes, i + 12);
    }
    if (type === "IDAT") sawIdat = true;
    if (PNG_KEEP.has(type)) chunks.push(bytes.slice(i, end));
    i = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend || !sawIdat) throw new ImageRejected("The PNG file is not valid.");
  return { bytes: concat(chunks), width, height };
}

function stripWebp(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const declared = readU32(bytes, 4);
  if (declared + 8 > bytes.length + 1 || declared < 4) throw new ImageRejected("The WebP file is not valid.");
  const chunks: { type: string; data: Uint8Array }[] = [];
  let i = 12;
  let width = 0;
  let height = 0;
  while (i + 8 <= bytes.length) {
    const type = readFour(bytes, i);
    const size = readU32(bytes, i + 4);
    const start = i + 8;
    const end = start + size;
    if (end > bytes.length) throw new ImageRejected("The WebP file is not valid.");
    const data = bytes.slice(start, end);
    if (type === "VP8X" && data.length >= 10) {
      if ((data[0] & 0x02) !== 0) throw new ImageRejected("Animated images are not allowed.");
      const flags = data[0] & ~0x30;
      const next = new Uint8Array(data);
      next[0] = flags;
      width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
      chunks.push({ type, data: next });
    } else if (type === "VP8 " && data.length > 9 && width === 0) {
      width = (data[6] | (data[7] << 8)) & 0x3fff;
      height = (data[8] | (data[9] << 8)) & 0x3fff;
      chunks.push({ type, data });
    } else if (type === "VP8L" && data.length > 4 && width === 0) {
      if (data[0] !== 0x2f) throw new ImageRejected("The WebP file is not valid.");
      const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      chunks.push({ type, data });
    } else if (type === "EXIF" || type === "XMP " || type === "ANIM" || type === "ANMF") {
      if (type === "ANIM" || type === "ANMF") throw new ImageRejected("Animated images are not allowed.");
    } else {
      chunks.push({ type, data });
    }
    i = end + (size % 2);
  }
  if (width < 1 || height < 1) throw new ImageRejected("The WebP file is not valid.");
  const parts: Uint8Array[] = [];
  let payload = 4;
  for (const chunk of chunks) {
    payload += 8 + chunk.data.length + (chunk.data.length % 2);
  }
  const header = new Uint8Array(12);
  header.set(text("RIFF"), 0);
  writeU32(header, 4, payload);
  header.set(text("WEBP"), 8);
  parts.push(header);
  for (const chunk of chunks) {
    const wrap = new Uint8Array(8 + chunk.data.length + (chunk.data.length % 2));
    wrap.set(text(chunk.type), 0);
    writeU32(wrap, 4, chunk.data.length);
    wrap.set(chunk.data, 8);
    parts.push(wrap);
  }
  return { bytes: concat(parts), width, height };
}

function readFour(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function text(value: string): Uint8Array {
  return Uint8Array.from(value.split("").map((char) => char.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
