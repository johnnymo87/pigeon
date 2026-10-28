import { createHash } from "crypto";

/**
 * pigeon's id for a goose session: `gse_` + uuidv5("<machineId>:<gooseId>").
 *
 * Derived, not random (pigeon-k0qn.13.4). With a random id, a goose row that
 * was reaped (7 days idle) or deleted and then registered again came back under
 * a NEW address: senders holding the old one were told it was not on this
 * machine, and mail banked in `pull_inbox` under the old id -- which is keyed by
 * session id and outlives the row -- could never be drained again. Deriving the
 * id makes the address a property of the goose session itself, so a re-created
 * row picks both back up.
 *
 * Why each input is there:
 *  - `gooseId` (goose's `YYYYMMDD_N`) identifies the session on its machine.
 *  - `machineId` because goose's counter is per machine: every machine's first
 *    session of a day is `YYYYMMDD_1`, and the worker keys sessions globally.
 *    A daemon with no machine id hashes "" -- still stable locally, and such a
 *    daemon has no worker, so nothing global to collide in.
 *
 * Existing rows are never re-keyed: callers look a row up by goose's id first
 * and only mint when none exists, so a row created under a random id keeps it
 * for as long as it lives. Changing the namespace or the name format changes
 * every future id; don't.
 */
export const GOOSE_SESSION_ID_NAMESPACE = "8cfe216a-9334-4a1d-81e0-8a5428af8245";

export function gooseSessionId(machineId: string | null | undefined, gooseId: string): string {
  return `gse_${uuidV5(GOOSE_SESSION_ID_NAMESPACE, `${machineId ?? ""}:${gooseId}`)}`;
}

/** RFC 4122 §4.3 name-based UUID, SHA-1 (version 5). */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`invalid namespace uuid: ${namespace}`);
  const bytes = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
