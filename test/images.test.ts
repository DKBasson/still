import { describe, expect, it } from "vitest";
import { ImageRejected, processImage } from "../src/worker/images";

const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (char) => char.charCodeAt(0));

const JPEG = hex(
  "ffd8ffe000104a46494600010100000100010000ffc0000b080001000101011100ffc40014000100000000000000000000000000000009ffc40014100100000000000000000000000000000000ffda0008010100003f007fffd9",
);

describe("image processing", () => {
  it("accepts a png and keeps its dimensions", () => {
    const image = processImage(PNG, 1024);
    expect(image.contentType).toBe("image/png");
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
  });

  it("strips jpeg comment and application segments", () => {
    const app = new Uint8Array([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const withExif = new Uint8Array(JPEG.length + app.length);
    withExif.set(JPEG.slice(0, 2), 0);
    withExif.set(app, 2);
    withExif.set(JPEG.slice(2), 2 + app.length);
    const image = processImage(withExif, 1024);
    expect(image.contentType).toBe("image/jpeg");
    expect(image.bytes.includes(0xe1)).toBe(false);
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
  });

  it("rejects files that are not photographs", () => {
    expect(() => processImage(new TextEncoder().encode("<svg></svg>"), 1024)).toThrow(ImageRejected);
  });

  it("rejects oversized files", () => {
    expect(() => processImage(JPEG, 8)).toThrow(/larger than the upload limit/);
  });
});

function hex(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
