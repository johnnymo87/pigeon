const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
export const DEFAULT_EXPIRY_MS = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

/**
 * Parses a duration string formatted as `<positive integer><unit>` where unit is
 * `s` (seconds), `m` (minutes), `h` (hours), or `d` (days).
 * Examples: "30s", "90m", "13h", "2d".
 *
 * Returns duration in milliseconds or `null` if invalid.
 */
export function parseDuration(s: unknown): number | null {
  if (typeof s !== "string") {
    return null;
  }
  const match = s.match(/^([1-9]\d*)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1_000;
    case "m":
      return value * 60 * 1_000;
    case "h":
      return value * 60 * 60 * 1_000;
    case "d":
      return value * 24 * 60 * 60 * 1_000;
    default:
      return null;
  }
}

export interface ParseScheduleInput {
  at?: unknown; // RFC3339 string with MANDATORY offset or Z
  after?: unknown; // duration string: "13h", "90m", "2d" (PREFERRED)
  expiresIn?: unknown; // optional duration string, same grammar as `after`
  now: number; // epoch ms, injected
}

export type ParseScheduleResult =
  | { ok: true; deliverAt: number; expiresAt: number | null }
  | { ok: false; error: string };

const HAS_OFFSET_REGEX = /(Z|z|[+-]\d{2}:?\d{2})$/;
const RFC3339_WITH_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses schedule parameters for scheduled swarm messages ("wake me at time T").
 *
 * `after` is the PREFERRED parameter as it is completely unambiguous.
 * Exactly one of `at` or `after` must be provided.
 */
export function parseScheduleTime(
  input: ParseScheduleInput,
): ParseScheduleResult {
  if (typeof input.now !== "number" || isNaN(input.now)) {
    return {
      ok: false,
      error: "`now` must be a valid epoch millisecond timestamp number",
    };
  }

  const hasAt = input.at !== undefined && input.at !== null;
  const hasAfter = input.after !== undefined && input.after !== null;

  if (!hasAt && !hasAfter) {
    return {
      ok: false,
      error: "Exactly one of `after` (preferred) or `at` must be specified",
    };
  }

  if (hasAt && hasAfter) {
    return {
      ok: false,
      error:
        "Cannot specify both `at` and `after`; use `after` (preferred) or `at`",
    };
  }

  let deliverAt: number;

  if (hasAfter) {
    if (typeof input.after !== "string") {
      return {
        ok: false,
        error:
          "`after` must be a duration string (e.g. '30s', '90m', '13h', '2d')",
      };
    }
    const durationMs = parseDuration(input.after);
    if (durationMs === null) {
      return {
        ok: false,
        error:
          "`after` duration string invalid; expected <positive integer><s|m|h|d> (e.g. '30s', '90m', '13h', '2d')",
      };
    }
    deliverAt = input.now + durationMs;
  } else {
    if (typeof input.at !== "string") {
      return {
        ok: false,
        error: "`at` must be an RFC3339 timestamp string",
      };
    }
    const isNaive =
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(input.at) &&
      !HAS_OFFSET_REGEX.test(input.at);
    if (isNaive) {
      return {
        ok: false,
        error:
          "`at` timestamp requires a mandatory timezone offset or 'Z' (e.g. '2026-08-01T09:20:00Z' or '2026-08-01T09:20:00+02:00')",
      };
    }
    const parsedAt = new Date(input.at).getTime();
    if (isNaN(parsedAt) || !RFC3339_WITH_OFFSET_REGEX.test(input.at)) {
      return {
        ok: false,
        error:
          "`at` must be a valid RFC3339 timestamp string with offset or 'Z'",
      };
    }

    const match = input.at.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const year = parseInt(match[1]!, 10);
      const month = parseInt(match[2]!, 10);
      const day = parseInt(match[3]!, 10);
      const hour = parseInt(match[4]!, 10);
      const minute = parseInt(match[5]!, 10);
      const second = parseInt(match[6]!, 10);

      const testUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      if (
        testUtc.getUTCFullYear() !== year ||
        testUtc.getUTCMonth() !== month - 1 ||
        testUtc.getUTCDate() !== day ||
        testUtc.getUTCHours() !== hour ||
        testUtc.getUTCMinutes() !== minute ||
        testUtc.getUTCSeconds() !== second
      ) {
        return {
          ok: false,
          error: `\`at\` timestamp contains invalid calendar date or time: '${input.at}'`,
        };
      }
    }

    deliverAt = parsedAt;
  }

  // Bounds check: must be strictly in the future relative to `now`
  if (deliverAt <= input.now) {
    return {
      ok: false,
      error: "`deliverAt` must be strictly in the future relative to `now`",
    };
  }

  // Bounds check: must be within 30-day horizon from `now`
  if (deliverAt > input.now + MAX_HORIZON_MS) {
    return {
      ok: false,
      error: "`deliverAt` exceeds the maximum scheduling horizon of 30 days",
    };
  }

  let expiresAt: number | null = null;
  if (input.expiresIn !== undefined && input.expiresIn !== null) {
    if (typeof input.expiresIn !== "string") {
      return {
        ok: false,
        error:
          "`expiresIn` must be a duration string (e.g. '30s', '90m', '13h', '2d')",
      };
    }
    const expiresInMs = parseDuration(input.expiresIn);
    if (expiresInMs === null) {
      return {
        ok: false,
        error:
          "`expiresIn` duration string invalid; expected <positive integer><s|m|h|d>",
      };
    }
    // `expiresAt` is measured from `deliverAt` (delivery time), NOT from `now`.
    // It represents "how long after the wake fires is it still worth delivering".
    expiresAt = deliverAt + expiresInMs;
  } else {
    expiresAt = deliverAt + DEFAULT_EXPIRY_MS;
  }

  return {
    ok: true,
    deliverAt,
    expiresAt,
  };
}
