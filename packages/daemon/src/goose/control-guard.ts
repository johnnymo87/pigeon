/**
 * Keeps goose session ids out of the opencode control path.
 *
 * THE HAZARD, verified in code rather than assumed
 *
 * Every control handler in `index.ts` begins by resolving an opencode client:
 * `clientForSession` -> `OpencodeClientFactory.forSession` -> `router.ensureRouted`
 * -> `placeSession`. For an id the router has never seen -- which is every goose
 * session, always -- `placeSession` does not politely decline. It writes a
 * `session_assignment` row AND acquires a live lease.
 *
 * Live leases are what `countLiveForServe` counts against `activeTurnCap`, so a
 * goose id passing through here does not merely acquire a meaningless row: it
 * consumes capacity that real opencode sessions are placed against, narrowing
 * their placement for as long as the lease lives. The damage is to OTHER
 * sessions, which is what makes it hard to attribute after the fact.
 *
 * There are NINE such call sites (onCommand, onKill, onInterrupt, onCompact,
 * onMcpList, onMcpEnable, onMcpDisable, onModelList, onModelSet). An earlier
 * count of six missed the last three; they are enumerated in a test so the next
 * handler added to that file has to notice this file exists.
 *
 * WHAT GOOSE CAN AND CANNOT DO
 *
 * Most of these commands have no goose equivalent, and the honest answer is to
 * say so rather than to half-answer. `/interrupt` is the one worth being careful
 * about: measured against 1.48.0, goose had no cancel method. On patched-1.54,
 * goose honours the notification-form `session/cancel` (verified live 2026-10-12).
 * /kill sends `session/cancel` against honkd and bare goose and closes the session.
 * On /interrupt pigeon sends no cancel, so a running goose turn cannot be stopped
 * from pigeon short of /kill. Claiming otherwise would fail at precisely the
 * moment the human needs it most, so the reply says what is true and points at
 * the one lever that does exist.
 */

/** What a control command should do when its target is a goose session. */
export type GooseControlVerdict =
  | { kind: "not-goose" }
  | { kind: "refuse"; reply: string }
  | { kind: "kill" };

export interface GooseControlLookup {
  /** The session's `backend_kind`, or undefined when there is no such session. */
  backendKindOf(sessionId: string): string | null | undefined;
  gooseBackendKind: string;
  /**
   * Whether the opencode serve pool may own this session (see
   * routing/opencode-routable.ts). Consulted only for non-goose sessions.
   */
  opencodeRoutable(sessionId: string): boolean;
}

/**
 * Decides whether a control command may proceed into the opencode path.
 *
 * `not-goose` means "carry on as before" — for every opencode session this is a
 * single map lookup and nothing changes.
 */
export function gooseControlVerdict(
  command: "kill" | "interrupt" | "compact" | "mcp" | "model",
  sessionId: string,
  lookup: GooseControlLookup,
): GooseControlVerdict {
  if (lookup.backendKindOf(sessionId) !== lookup.gooseBackendKind) {
    if (lookup.opencodeRoutable(sessionId)) return { kind: "not-goose" };
    // A registered session the opencode pool must not own: no backend at all,
    // or a kind this daemon has no adapter for. `clientForSession` returns
    // undefined for it, and the handlers treat that as "log and go quiet", so
    // answering here is the difference between an honest reply and silence.
    // Nothing is torn down, /kill included: there is no backend to stop, and a
    // registrant that re-registers on its next /session-start would bring the
    // row straight back.
    return {
      kind: "refuse",
      reply:
        `/${command} is not available for this session: it has no backend pigeon can control. `
        + "It can post to this topic, but pigeon cannot stop, steer or configure it from here.",
    };
  }

  switch (command) {
    case "kill":
      return { kind: "kill" };
    case "interrupt":
      return {
        kind: "refuse",
        reply:
          "/interrupt cannot stop a turn that has started. "
          + "Sending a message now steers the running turn instead — the model "
          + "decides whether to change course, so it is not a stop. /kill asks goose to "
          + "cancel the turn and stops pigeon tracking the session.",
      };
    case "compact":
      return {
        kind: "refuse",
        reply: "/compact is not supported for goose sessions.",
      };
    case "mcp":
      return {
        kind: "refuse",
        reply:
          "/mcp is not supported for goose sessions. goose extensions are "
          + "configured in its own config, not per session from here.",
      };
    case "model":
      return {
        kind: "refuse",
        reply: "/model is not supported for goose sessions.",
      };
  }
}
