export type Activity = "active" | "idle";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

/**
 * Classify a session's activity based on its messages list.
 */
export function classifyActivity(messages: unknown[]): Activity {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "idle";
  }

  const lastMsg = messages[messages.length - 1];
  if (!isObject(lastMsg)) {
    return "idle";
  }

  const info = lastMsg.info;
  if (!isObject(info)) {
    return "idle";
  }

  const role = info.role;
  if (typeof role !== "string") {
    return "idle";
  }

  if (role === "user") {
    return "active";
  }

  if (role === "assistant") {
    const time = info.time;
    if (isObject(time) && time.completed !== undefined && time.completed !== null) {
      return "idle";
    }
    return "active";
  }

  return "idle";
}

/**
 * Extracts a trimmed snippet of up to maxLen from the most recent assistant message's last non-empty text part.
 */
export function snippetFromMessages(messages: unknown[], maxLen = 200): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  // Iterate backward to find the most recent assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isObject(msg)) continue;

    const info = msg.info;
    if (!isObject(info) || info.role !== "assistant") continue;

    const parts = msg.parts;
    if (!Array.isArray(parts)) continue;

    // Iterate backward to find the last non-empty text part
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isObject(part) || part.type !== "text") continue;

      const text = part.text;
      if (typeof text !== "string") continue;

      const trimmed = text.trim();
      if (trimmed !== "") {
        return trimmed.length > maxLen ? trimmed.slice(0, maxLen).trim() : trimmed;
      }
    }
  }

  return "";
}

/**
 * Finds the newest timestamp across all messages.
 * Uses info.time.completed ?? info.time.created.
 */
export function lastActivityFromMessages(messages: unknown[]): number | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  let maxTime: number | null = null;

  for (const msg of messages) {
    if (!isObject(msg)) continue;

    const info = msg.info;
    if (!isObject(info)) continue;

    const time = info.time;
    if (!isObject(time)) continue;

    const completed = time.completed;
    const created = time.created;

    let t: number | null = null;
    if (typeof completed === "number" && !Number.isNaN(completed)) {
      t = completed;
    } else if (typeof created === "number" && !Number.isNaN(created)) {
      t = created;
    }

    if (t !== null) {
      if (maxTime === null || t > maxTime) {
        maxTime = t;
      }
    }
  }

  return maxTime;
}
