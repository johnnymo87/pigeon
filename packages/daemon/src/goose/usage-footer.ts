/**
 * Parsing and footer formatting for goose usage metrics.
 *
 * Goose ACP sessions emit usage_update updates, and honkd turn.ended events
 * optionally forward the latest usage metric.
 */

export interface GooseUsageCost {
  amount: number;
  currency: string;
}

export interface GooseUsage {
  used: number;
  size: number;
  cost?: GooseUsageCost;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.floor(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Accepts either a usage_update update object or a hook usage object.
 * Validates used/size/cost and returns GooseUsage or undefined.
 */
export function parseGooseUsage(x: unknown): GooseUsage | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return undefined;
  }
  const obj = x as Record<string, unknown>;
  if (typeof obj.used !== "number" || !Number.isFinite(obj.used) || obj.used < 0) {
    return undefined;
  }

  let size = 0;
  if (obj.size !== undefined) {
    if (typeof obj.size !== "number" || !Number.isFinite(obj.size) || obj.size < 0) {
      return undefined;
    }
    size = obj.size;
  }

  let cost: GooseUsageCost | undefined;
  if (obj.cost !== undefined) {
    if (typeof obj.cost !== "object" || obj.cost === null || Array.isArray(obj.cost)) {
      return undefined;
    }
    const c = obj.cost as Record<string, unknown>;
    if (typeof c.amount !== "number" || !Number.isFinite(c.amount)) {
      return undefined;
    }
    if (typeof c.currency !== "string" || c.currency.length === 0) {
      return undefined;
    }
    cost = { amount: c.amount, currency: c.currency };
  }

  return {
    used: obj.used,
    size,
    ...(cost ? { cost } : {}),
  };
}

/**
 * Formats a GooseUsage object into a footer string:
 * `📊 <tokens> tokens · <pct>% · <cost>`
 * Returns undefined if used is 0 (nothing to show).
 */
export function formatGooseUsageFooter(u: GooseUsage): string | undefined {
  if (u.used <= 0) {
    return undefined;
  }

  const segments: string[] = [];
  segments.push(`${formatTokenCount(u.used)} tokens`);

  if (u.size > 0) {
    const pct = Math.round((u.used / u.size) * 100);
    segments.push(`${pct}%`);
  }

  if (u.cost && u.cost.amount > 0) {
    let formattedCost: string;
    try {
      formattedCost = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: u.cost.currency,
      }).format(u.cost.amount);
    } catch {
      formattedCost = `${u.cost.amount.toFixed(2)} ${u.cost.currency}`;
    }
    segments.push(formattedCost);
  }

  return `📊 ${segments.join(" · ")}`;
}
