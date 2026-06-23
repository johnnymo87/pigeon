import { randomUUID } from "node:crypto";

/**
 * Generate a swarm message id. Sortable-ish by createdAt: a base36 timestamp
 * prefix plus a short random suffix. The inbox `since` cursor relies on
 * lexicographic msg_id order to approximate arrival order; the timestamp
 * prefix gives us that for free.
 */
export function makeMsgId(): string {
  return `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}
