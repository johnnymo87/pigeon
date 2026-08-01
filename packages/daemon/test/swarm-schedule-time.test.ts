import { describe, expect, it } from "vitest";
import {
  parseDuration,
  parseScheduleTime,
  type ParseScheduleInput,
  type ParseScheduleResult,
} from "../src/swarm/schedule-time";

const NOW = new Date("2026-08-01T12:00:00.000Z").getTime(); // 1785585600000

describe("parseDuration", () => {
  const validCases: Array<{ input: unknown; expected: number }> = [
    { input: "30s", expected: 30_000 },
    { input: "90m", expected: 5_400_000 },
    { input: "13h", expected: 46_800_000 },
    { input: "2d", expected: 172_800_000 },
  ];

  it.each(validCases)(
    "parses valid duration $input to $expected ms",
    ({ input, expected }) => {
      expect(parseDuration(input)).toBe(expected);
    },
  );

  const invalidCases: Array<{ name: string; input: unknown }> = [
    { name: "empty string", input: "" },
    { name: "number without unit", input: "13" },
    { name: "unknown unit w", input: "13w" },
    { name: "unknown unit y", input: "13y" },
    { name: "zero seconds", input: "0s" },
    { name: "zero hours", input: "0h" },
    { name: "negative duration", input: "-1h" },
    { name: "non-integer float", input: "1.5h" },
    { name: "leading space", input: " 13h" },
    { name: "trailing space", input: "13h " },
    { name: "compound duration", input: "1h30m" },
    { name: "number type", input: 13 },
    { name: "null", input: null },
    { name: "object", input: {} },
    { name: "array", input: ["13h"] },
  ];

  it.each(invalidCases)("rejects invalid duration: $name", ({ input }) => {
    expect(parseDuration(input)).toBeNull();
  });
});

describe("parseScheduleTime", () => {
  const validCases: Array<{
    name: string;
    input: ParseScheduleInput;
    expectedDeliverAt: number;
    expectedExpiresAt: number | null;
  }> = [
    {
      name: "valid after duration in seconds",
      input: { after: "30s", now: NOW },
      expectedDeliverAt: NOW + 30_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid after duration in minutes",
      input: { after: "90m", now: NOW },
      expectedDeliverAt: NOW + 5_400_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid after duration in hours",
      input: { after: "13h", now: NOW },
      expectedDeliverAt: NOW + 46_800_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid after duration in days",
      input: { after: "2d", now: NOW },
      expectedDeliverAt: NOW + 172_800_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid at with Z timezone",
      input: { at: "2026-08-01T13:00:00Z", now: NOW },
      expectedDeliverAt: NOW + 3_600_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid at with offset (+02:00)",
      input: { at: "2026-08-01T15:00:00+02:00", now: NOW },
      expectedDeliverAt: NOW + 3_600_000,
      expectedExpiresAt: null,
    },
    {
      name: "valid at with fractional seconds",
      input: { at: "2026-08-01T13:00:00.123Z", now: NOW },
      expectedDeliverAt: NOW + 3_600_000 + 123,
      expectedExpiresAt: null,
    },
    {
      name: "valid expiresIn present measured from deliverAt",
      input: { after: "2d", expiresIn: "1h", now: NOW },
      expectedDeliverAt: NOW + 172_800_000,
      expectedExpiresAt: NOW + 172_800_000 + 3_600_000,
    },
  ];

  it.each(validCases)(
    "successfully parses schedule: $name",
    ({ input, expectedDeliverAt, expectedExpiresAt }) => {
      const result = parseScheduleTime(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.deliverAt).toBe(expectedDeliverAt);
        expect(result.expiresAt).toBe(expectedExpiresAt);
      }
    },
  );

  it("explicitly verifies expiresIn is measured from deliverAt, not from now", () => {
    const result = parseScheduleTime({
      after: "10d",
      expiresIn: "2h",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const deliverAt = NOW + 10 * 24 * 3_600 * 1_000;
      const expiresInMs = 2 * 3_600 * 1_000;
      expect(result.deliverAt).toBe(deliverAt);
      expect(result.expiresAt).toBe(deliverAt + expiresInMs);
      expect(result.expiresAt).not.toBe(NOW + expiresInMs);
    }
  });

  const rejectionCases: Array<{
    name: string;
    input: ParseScheduleInput;
    expectedKeyKeyword: string;
  }> = [
    {
      name: "neither at nor after provided",
      input: { now: NOW },
      expectedKeyKeyword: "at",
    },
    {
      name: "both at and after provided",
      input: { at: "2026-08-01T13:00:00Z", after: "1h", now: NOW },
      expectedKeyKeyword: "both",
    },
    {
      name: "naive at wall-clock without offset (T)",
      input: { at: "2026-08-01T13:00:00", now: NOW },
      expectedKeyKeyword: "offset",
    },
    {
      name: "naive at wall-clock without offset (space)",
      input: { at: "2026-08-01 13:00", now: NOW },
      expectedKeyKeyword: "offset",
    },
    {
      name: "invalid at string",
      input: { at: "not-a-date", now: NOW },
      expectedKeyKeyword: "RFC3339",
    },
    {
      name: "past at time",
      input: { at: "2026-08-01T11:00:00Z", now: NOW },
      expectedKeyKeyword: "future",
    },
    {
      name: "exactly now at time",
      input: { at: "2026-08-01T12:00:00Z", now: NOW },
      expectedKeyKeyword: "future",
    },
    {
      name: "at time beyond 30-day horizon",
      input: { at: "2026-09-05T12:00:00Z", now: NOW },
      expectedKeyKeyword: "30 day",
    },
    {
      name: "after duration beyond 30-day horizon",
      input: { after: "31d", now: NOW },
      expectedKeyKeyword: "30 day",
    },
    {
      name: "invalid after duration format",
      input: { after: "13", now: NOW },
      expectedKeyKeyword: "duration",
    },
    {
      name: "zero after duration",
      input: { after: "0h", now: NOW },
      expectedKeyKeyword: "duration",
    },
    {
      name: "compound after duration",
      input: { after: "1h30m", now: NOW },
      expectedKeyKeyword: "duration",
    },
    {
      name: "non-string at type (number)",
      input: { at: 123, now: NOW },
      expectedKeyKeyword: "string",
    },
    {
      name: "non-string at type (object)",
      input: { at: {}, now: NOW },
      expectedKeyKeyword: "string",
    },
    {
      name: "non-string after type (number)",
      input: { after: 123, now: NOW },
      expectedKeyKeyword: "string",
    },
    {
      name: "non-string after type (array)",
      input: { after: ["30s"], now: NOW },
      expectedKeyKeyword: "string",
    },
    {
      name: "non-string expiresIn type (number)",
      input: { after: "1h", expiresIn: 123, now: NOW },
      expectedKeyKeyword: "expiresIn",
    },
    {
      name: "invalid expiresIn duration string",
      input: { after: "1h", expiresIn: "invalid", now: NOW },
      expectedKeyKeyword: "expiresIn",
    },
  ];

  it.each(rejectionCases)(
    "rejects invalid input: $name",
    ({ input, expectedKeyKeyword }) => {
      const result = parseScheduleTime(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeTruthy();
        expect(result.error.toLowerCase()).toContain(
          expectedKeyKeyword.toLowerCase(),
        );
      }
    },
  );
});
