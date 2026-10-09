import { describe, expect, it } from "vitest";
import { parsePreviewEnvelope } from "../bridge";

/** Builds an envelope byte for byte the way preview_envelope (lib.rs)
 * does: "HPRV", u32 LE metadata length, metadata JSON, image bytes. The
 * Rust test pins the writer; this pins the reader against the same
 * layout. */
function envelope(meta: object, image: number[]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(8 + json.length + image.length);
  out.set([0x48, 0x50, 0x52, 0x56], 0); // "HPRV"
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(image, 8 + json.length);
  return out.buffer;
}

describe("parsePreviewEnvelope", () => {
  const meta = {
    mime: "image/jpeg",
    ms: 7,
    image_id: "img_1",
    backend: "cpu",
    roi: [0.25, 0.25, 0.5, 0.5],
    frame: [6000, 4000],
  };

  it("keeps the once-only memory notice with the displayed frame", () => {
    const notice = "Preview reduced to 1024 pixels: /photos/panorama.dng";
    const parsed = parsePreviewEnvelope(envelope({ ...meta, memory_notice: notice }, [1]));
    expect(parsed.meta.memory_notice).toBe(notice);
  });

  it("splits metadata from the image bytes", () => {
    const parsed = parsePreviewEnvelope(envelope(meta, [0xff, 0xd8, 0x00, 0x42]));
    expect(parsed.meta).toEqual(meta);
    expect(Array.from(parsed.bytes)).toEqual([0xff, 0xd8, 0x00, 0x42]);
  });

  it("hands over the drag frame's libjpeg-turbo JPEG byte for byte", () => {
    // Since 2026-09-30 the viewer's frames come from libjpeg-turbo
    // (encode_preview_jpeg, lib.rs): a JFIF APP0, then the sRGB profile
    // in an APP2 segment, then the frame. The type is unchanged, so the
    // Blob URL and the <img> decode take it as before.
    const icc = Array.from(new TextEncoder().encode("ICC_PROFILE\0"));
    const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const app2 = [0xff, 0xe2, 0x00, 2 + icc.length + 2 + 3, ...icc, 1, 1, 0x61, 0x63, 0x73];
    const frame = [...head, ...app2, 0xff, 0xd9];
    const parsed = parsePreviewEnvelope(envelope(meta, frame));
    expect(parsed.meta.mime).toBe("image/jpeg");
    expect(Array.from(parsed.bytes)).toEqual(frame);
  });

  it("accepts a Uint8Array view as well as an ArrayBuffer", () => {
    const buf = envelope(meta, [1, 2, 3]);
    const parsed = parsePreviewEnvelope(new Uint8Array(buf));
    expect(parsed.meta.image_id).toBe("img_1");
    expect(Array.from(parsed.bytes)).toEqual([1, 2, 3]);
  });

  it("refuses buffers that are not envelopes", () => {
    // A JSON reply that never went through the envelope writer: the old
    // wire format, or a desync. Must throw, not decode as an image.
    const json = new TextEncoder().encode('{"url":"data:..."}');
    expect(() => parsePreviewEnvelope(json.buffer as ArrayBuffer)).toThrow(/not a preview envelope/);
    expect(() => parsePreviewEnvelope(new ArrayBuffer(3))).toThrow(/not a preview envelope/);
  });

  it("refuses a truncated envelope", () => {
    const whole = new Uint8Array(envelope(meta, [1, 2, 3]));
    const cut = whole.slice(0, 20).buffer;
    expect(() => parsePreviewEnvelope(cut as ArrayBuffer)).toThrow(/truncated/);
  });
});
