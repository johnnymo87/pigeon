import { describe, expect, it } from "vitest";
import {
  decodedBase64Bytes,
  MAX_OUTBOUND_MEDIA_BYTES,
  MAX_OUTBOUND_MEDIA_FILES,
  parseStopMedia,
  sanitizeMediaFilename,
  withMediaExtension,
} from "../src/outbound-media";

const PNG = Buffer.from("fake png bytes").toString("base64");

describe("parseStopMedia", () => {
  it("accepts a base64 data URI and keeps only its body", () => {
    const { media, skipped } = parseStopMedia([
      { mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG}` },
    ]);
    expect(skipped).toEqual([]);
    expect(media).toEqual([{ mime: "image/png", filename: "shot.png", data: PNG }]);
  });

  it("returns nothing for a missing or non-array field", () => {
    expect(parseStopMedia(undefined)).toEqual({ media: [], skipped: [] });
    expect(parseStopMedia("x")).toEqual({ media: [], skipped: [] });
  });

  it("skips URLs that are not base64 data URIs, so the daemon never fetches one", () => {
    const { media, skipped } = parseStopMedia([
      { mime: "image/png", filename: "a.png", url: "https://example.com/a.png" },
      { mime: "image/png", filename: "b.png", url: "file:///etc/passwd" },
      { mime: "text/plain", filename: "c.txt", url: "data:text/plain,hello" },
    ]);
    expect(media).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "not_a_base64_data_uri",
      "not_a_base64_data_uri",
      "not_a_base64_data_uri",
    ]);
  });

  it("skips a bad mime, bad base64 and a non-object", () => {
    const { media, skipped } = parseStopMedia([
      { mime: "nope", filename: "a", url: `data:x;base64,${PNG}` },
      { mime: "image/png", filename: "a", url: "data:image/png;base64,@@@" },
      null,
    ]);
    expect(media).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["bad_mime", "bad_base64", "not_an_object"]);
  });

  it("caps the file count", () => {
    const items = Array.from({ length: MAX_OUTBOUND_MEDIA_FILES + 2 }, (_, i) => ({
      mime: "image/png",
      filename: `${i}.png`,
      url: `data:image/png;base64,${PNG}`,
    }));
    const { media, skipped } = parseStopMedia(items);
    expect(media).toHaveLength(MAX_OUTBOUND_MEDIA_FILES);
    expect(skipped.map((s) => s.reason)).toEqual(["too_many_files", "too_many_files"]);
  });

  it("skips a file over the per-file cap", () => {
    const big = "A".repeat(4 * Math.ceil((MAX_OUTBOUND_MEDIA_BYTES + 1) / 3));
    const { media, skipped } = parseStopMedia([
      { mime: "image/png", filename: "big.png", url: `data:image/png;base64,${big}` },
    ]);
    expect(media).toEqual([]);
    expect(skipped[0]!.reason).toBe("too_large");
  });

  it("reduces the filename to a safe basename", () => {
    const { media } = parseStopMedia([
      { mime: "image/png", filename: "/tmp/../x/shot\u0007.png", url: `data:image/png;base64,${PNG}` },
    ]);
    expect(media[0]!.filename).toBe("shot.png");
  });
});

describe("filename extension", () => {
  it("names an unnamed attachment after its mime type", () => {
    const { media } = parseStopMedia([{ mime: "image/png", filename: "file", url: `data:image/png;base64,${PNG}` }]);
    expect(media[0]!.filename).toBe("file.png");
  });

  it("leaves a name that has an extension, and an unknown mime, alone", () => {
    expect(withMediaExtension("shot.jpeg", "image/png")).toBe("shot.jpeg");
    expect(withMediaExtension("blob", "application/x-thing")).toBe("blob");
  });
});

describe("sanitizeMediaFilename", () => {
  it("falls back to 'file' for an empty or dot name", () => {
    expect(sanitizeMediaFilename("")).toBe("file");
    expect(sanitizeMediaFilename("a/..")).toBe("file");
    expect(sanitizeMediaFilename("dir\\")).toBe("file");
  });

  it("truncates to 128 characters", () => {
    expect(sanitizeMediaFilename("x".repeat(300))).toHaveLength(128);
  });
});

describe("decodedBase64Bytes", () => {
  it("accounts for padding", () => {
    expect(decodedBase64Bytes(Buffer.from("a").toString("base64"))).toBe(1);
    expect(decodedBase64Bytes(Buffer.from("ab").toString("base64"))).toBe(2);
    expect(decodedBase64Bytes(Buffer.from("abc").toString("base64"))).toBe(3);
  });
});
