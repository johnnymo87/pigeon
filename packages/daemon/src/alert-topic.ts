/**
 * Optional named topic for `POST /alert`: `topic: {key, name}`.
 *
 * A caller that posts recurring alerts (a digest, a watcher) can keep them out of General by
 * naming a topic of its own. The worker owns the key -> forum-thread mapping
 * (`POST /topics/named`, which creates the topic on first use); the daemon only resolves the key
 * and then sends the alert itself, exactly as it sends any plain alert.
 *
 * Like link buttons, this FAILS OPEN: a malformed `topic`, no worker connection, a slow or failing
 * worker, all post the alert to General as before. A `topic` never produces a 4xx.
 */

/** Same rule as the worker's NAMED_TOPIC_KEY_RE; checked here so a bad key costs no round trip. */
export const ALERT_TOPIC_KEY_RE = /^[A-Za-z0-9:._-]{1,64}$/;

/** Bound on resolving a topic. Longer than the link lookup: a first use creates the topic. */
export const DEFAULT_TOPIC_RESOLVE_TIMEOUT_MS = 3_000;

export interface AlertTopic {
  key: string;
  name: string;
}

export interface ResolvedTopic {
  messageThreadId: number;
  created: boolean;
}

export type NamedTopicResolver = (
  req: { key: string; name: string; staleThreadId?: number },
  signal?: AbortSignal,
) => Promise<ResolvedTopic>;

export function parseAlertTopic(raw: unknown): AlertTopic | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { key, name } = raw as { key?: unknown; name?: unknown };
  if (typeof key !== "string" || !ALERT_TOPIC_KEY_RE.test(key)) return undefined;
  const n = typeof name === "string" ? name.trim() : "";
  return { key, name: n || key };
}

/**
 * Resolve `topic` to a thread, bounded by `timeoutMs`, never throwing. Undefined means "post to
 * General". The deadline is raced explicitly so a resolver that ignores its signal cannot hold the
 * alert open (same reasoning as `sendPlainAlert`, pigeon-wfj1).
 */
export async function resolveAlertTopic(
  topic: AlertTopic,
  resolver: NamedTopicResolver | undefined,
  timeoutMs: number = DEFAULT_TOPIC_RESOLVE_TIMEOUT_MS,
  staleThreadId?: number,
): Promise<ResolvedTopic | undefined> {
  if (!resolver) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    const inFlight = resolver(
      staleThreadId === undefined ? { ...topic } : { ...topic, staleThreadId },
      controller.signal,
    );
    inFlight.catch(() => {});
    const res = await Promise.race([inFlight, deadline]);
    if (
      !res ||
      typeof res !== "object" ||
      typeof res.messageThreadId !== "number" ||
      !Number.isInteger(res.messageThreadId) ||
      res.messageThreadId <= 0
    ) {
      if (res === undefined && controller.signal.aborted) {
        console.warn(`[alert] topic resolve timed out after ${timeoutMs}ms; posting to General`);
      }
      return undefined;
    }
    return { messageThreadId: res.messageThreadId, created: res.created === true };
  } catch (err) {
    console.warn(
      `[alert] topic resolve failed; posting to General: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
