/**
 * The `sessions.backend_kind` value identifying a goose-over-ACP session.
 *
 * A named constant rather than a literal because this string is a dispatch key
 * in three places that must agree -- adapter selection, the control-path guard
 * that keeps goose ids out of opencode's router, and session creation -- and a
 * typo in any one of them fails by routing a goose session into the opencode
 * machinery, which is the failure this whole layer exists to prevent.
 */
export const GOOSE_BACKEND_KIND = "goose-acp";
