import { verifyApiKey, unauthorized } from "./auth";
import { pollNextCommand, ackCommand, touchMachine } from "./d1-ops";
import { createTelegramClient } from "./telegram";
import { topicsEnabled } from "./topics";

/**
 * The capability header a daemon sends to say what it can launch. Spelled
 * byte-exact here and in `packages/daemon/src/worker/backends.ts`, and pinned
 * by tests on both sides: a rename on one side alone must fail a suite, because
 * a gate that never matches looks exactly like a gate that always passes.
 */
export const BACKENDS_HEADER = "X-Pigeon-Backends";

/**
 * What a launch means when nothing says otherwise. Applies to an ordinary
 * `/launch` (no `--backend`), and to what a pre-gate daemon is assumed to be
 * able to serve.
 */
const DEFAULT_BACKEND = "opencode";

/**
 * A refusal costs one Telegram send, and the daemon sleeps ~5s between polls,
 * so N queued unservable launches would otherwise take N*5s to drain while any
 * ordinary command created after them waits behind (`pollNextCommand` is
 * LIMIT 1, ORDER BY created_at). Draining a few per poll keeps a burst of
 * mistakes from stalling a machine's real work. Bounded because each iteration
 * is a subrequest and an unbounded loop would be a way to hang the handler.
 */
const MAX_REFUSALS_PER_POLL = 5;

/**
 * Which backends the polling daemon says it can serve.
 *
 * An ABSENT header means a daemon that predates the gate, which could only ever
 * launch opencode -- so it is credited with exactly that. A PRESENT header is
 * taken literally, including when it lists nothing servable: the daemon's
 * `none` sentinel lands here as a token that matches no backend, which refuses
 * everything without this function needing to know the word exists.
 */
export function parseAdvertisedBackends(header: string | null): Set<string> {
  if (header === null) return new Set([DEFAULT_BACKEND]);
  return new Set(
    header
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
}

/**
 * Whether a failed Telegram send is worth retrying.
 *
 * This is what decides if a refusal may be acked. Acking after a send that
 * never arrived destroys the command silently -- the precise failure the gate
 * exists to prevent -- so a transient failure must leave the row leased and let
 * the 60s lease lapse into an ordinary retry. A PERMANENT failure must ack
 * anyway: a deleted topic or a blocked bot will not start working, and holding
 * the row buys 24h of retries nobody can see.
 */
function isPermanentSendFailure(res: { ok: false; kind: string; errorCode?: number }): boolean {
  // The chat or topic is gone. Retrying cannot conjure it back.
  if (res.kind === "thread_not_found" || res.kind === "topic_not_modified") return true;
  // Telegram asked us to slow down; that is the definition of transient.
  if (res.kind === "rate_limited") return false;
  // A missing errorCode does NOT mean the request failed to go out: a genuine
  // network failure THROWS out of the telegram client, past this function
  // entirely, and is turned into a 500 by the router -- which leaves the row
  // leased and retried, the outcome we want, reached by a different road. What
  // lands here without a code is an HTTP 200 carrying a body we could not
  // parse, i.e. Telegram very likely DID deliver. Treating it as retryable
  // therefore risks a duplicate refusal rather than a lost one, which is the
  // side to err on and matches how the rest of this worker treats an
  // unparseable Telegram response.
  if (res.errorCode === undefined) return false;
  // A 4xx is Telegram refusing on the merits and will refuse identically
  // forever; a 5xx is Telegram being unwell, which may pass.
  return res.errorCode >= 400 && res.errorCode < 500;
}

function parseMetadata(metadataJson: string | null | undefined): Record<string, string | undefined> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | undefined>) : {};
  } catch {
    return {};
  }
}

/**
 * GET /machines/:id/next
 *
 * Poll for next pending command for a machine.
 * Returns 204 if no commands available.
 * Returns JSON command payload if a command is available.
 * Updates machine last_poll_at for online detection.
 */
export async function handlePollNext(
  db: D1Database,
  env: Env,
  request: Request,
  machineId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  await touchMachine(db, machineId);

  const rawHeader = request.headers.get(BACKENDS_HEADER);
  const advertised = parseAdvertisedBackends(rawHeader);

  // Refuse up to a few unservable commands per poll rather than one, so a burst
  // of them cannot hold up the ordinary commands queued behind.
  for (let attempt = 0; attempt < MAX_REFUSALS_PER_POLL; attempt++) {
    const result = await pollNextCommand(db, machineId);
    if (!result) {
      return new Response(null, { status: 204 });
    }

    // Only a launch chooses a backend; everything else targets a session that
    // already exists and is routed by the backend recorded on that session.
    if (result.commandType !== "launch") {
      return Response.json(buildCommandBody(result));
    }

    // Corrupt metadata_json parses to {} and therefore lands here as the
    // default, i.e. a corrupt row launches opencode rather than being refused.
    // Accepted knowingly: the column is only writable by a holder of the API
    // key, and the alternative -- refusing on unparseable metadata -- would
    // turn a storage glitch into a dead command.
    // Lowercased to match how the advertised set is normalised. Without this a
    // writer storing `Goose` would be refused by a daemon advertising `goose`,
    // and the two sides would disagree over nothing but case.
    const required = (parseMetadata(result.metadataJson).backend ?? DEFAULT_BACKEND).trim().toLowerCase();
    if (advertised.has(required)) {
      const body = buildCommandBody(result);
      // Echoed back only when explicitly asked for, so an ordinary launch's
      // wire shape is byte-identical to what it was before the gate existed.
      if (parseMetadata(result.metadataJson).backend) body.backend = required;
      return Response.json(body);
    }

    const acked = await refuseUnservableLaunch(db, env, {
      commandId: result.commandId,
      chatId: result.chatId,
      messageThreadId: result.messageThreadId,
      machineId,
      required,
      advertised,
      headerPresent: rawHeader !== null,
    });

    // The refusal could not be delivered for a reason that may pass. Leave the
    // row leased and stop: the lease lapses in 60s and the whole refusal is
    // retried.
    //
    // Stopping rather than continuing is a weak preference, not a guarantee of
    // ordering -- the next poll 5s later will skip this still-leased row and
    // refuse the ones behind it anyway. It buys only that we do not pile up
    // further sends in the same poll while Telegram is visibly unhappy.
    if (!acked) {
      return new Response(null, { status: 204 });
    }
  }

  return new Response(null, { status: 204 });
}

/**
 * Tells the human their launch cannot be served here, and reports whether the
 * command may now be acked.
 *
 * Returns false when the send failed in a way that might succeed later, which
 * the caller must treat as "leave it leased" -- acking an undelivered refusal
 * destroys the command silently, and silent destruction is the whole reason
 * this gate exists.
 */
async function refuseUnservableLaunch(
  db: D1Database,
  env: Env,
  info: {
    commandId: string;
    chatId: string;
    messageThreadId?: number | null;
    machineId: string;
    required: string;
    advertised: Set<string>;
    headerPresent: boolean;
  },
): Promise<boolean> {
  // The two causes need different instructions, and guessing wrong sends the
  // human to edit a config file on a daemon that is simply too old, or to
  // upgrade a daemon whose config is merely missing a variable.
  const diagnosis = info.headerPresent
    ? `${info.machineId} does not have the ${info.required} backend configured.`
    : `${info.machineId} is running a daemon that predates backend selection, so it can only launch ${DEFAULT_BACKEND}. Update it.`;

  const text = [
    `Cannot launch ${info.required} on ${info.machineId}.`,
    "",
    diagnosis,
    `That daemon offers: ${[...info.advertised].join(", ") || "nothing"}.`,
    "",
    "The command was dropped; nothing was started. Re-send it once the machine can serve that backend.",
  ].join("\n");

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const res = await tg.sendMessage({
    chatId: info.chatId,
    text,
    messageThreadId: topicsEnabled(env) ? info.messageThreadId ?? undefined : undefined,
  });

  if (!res.ok && !isPermanentSendFailure(res)) {
    console.error("[poll] refusal send failed, leaving command leased for retry", {
      commandId: info.commandId,
      machineId: info.machineId,
      required: info.required,
      kind: res.kind,
      ...(res.kind === "rate_limited" ? { retryAfter: res.retryAfter } : {}),
    });
    return false;
  }

  // A refused row and a served row both end up `acked`, so without this line
  // the gate is invisible in production: there is no way to tell a machine
  // refusing every goose launch from one nobody is asking.
  console.error("[poll] refused launch: daemon cannot serve backend", {
    commandId: info.commandId,
    machineId: info.machineId,
    required: info.required,
    advertised: [...info.advertised],
    headerPresent: info.headerPresent,
    delivered: res.ok,
  });

  await ackCommand(db, info.commandId);
  return true;
}

function buildCommandBody(result: Awaited<ReturnType<typeof pollNextCommand>> & object): Record<string, unknown> {
  // Shape the response based on command type
  const body: Record<string, unknown> = {
    commandId: result.commandId,
    commandType: result.commandType,
    chatId: result.chatId,
    messageThreadId: result.messageThreadId,
  };

  if (result.commandType === "launch") {
    body.directory = result.directory;
    body.prompt = result.command;
    // The optional /launch --tag travels in metadata_json; the command column is
    // the prompt. Left undefined when absent (the ordinary untagged launch, and
    // also corrupt metadata, which parseMetadata turns into {}) — an empty
    // string would fail the daemon's tag validator and put a spurious
    // "Tag not applied" line on every launch.
    const tag = parseMetadata(result.metadataJson).tag;
    if (tag) body.tag = tag;
  } else if (result.commandType === "kill") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "interrupt") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "compact") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "mcp_list" || result.commandType === "model_list") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "mcp_enable" || result.commandType === "mcp_disable") {
    body.sessionId = result.sessionId;
    body.serverName = result.command; // server name stored in command column
  } else if (result.commandType === "model_set") {
    body.sessionId = result.sessionId;
    body.model = result.command; // model code stored in command column
  } else if (result.commandType === "tag_top" || result.commandType === "tag_list") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "tag_set" || result.commandType === "tag_set_dir") {
    // sessionId is the CONTEXT session (routing + unread badge). What is being
    // tagged travels in metadata_json, because for tag_set it may be a different
    // session entirely -- that is the whole point of the backlog view.
    body.sessionId = result.sessionId;
    body.tag = result.command; // tag stored in command column
    const meta = parseMetadata(result.metadataJson);
    if (result.commandType === "tag_set") {
      // No fallback to result.sessionId. Absent metadata means we do not know
      // what to tag, and defaulting to the context session would silently tag
      // the WRONG session; leaving it undefined makes the daemon's validator
      // reject it out loud.
      body.targetSessionId = meta.targetSessionId;
    } else {
      body.pattern = meta.pattern;
    }
  } else {
    // "execute" -- regular command
    body.sessionId = result.sessionId;
    body.command = result.command;
    if (result.mediaJson) {
      try {
        body.media = JSON.parse(result.mediaJson);
      } catch {
        // Ignore malformed media JSON
      }
    }
    if (result.metadataJson) {
      try {
        body.metadata = JSON.parse(result.metadataJson);
      } catch {
        // Ignore malformed metadata JSON
      }
    }
  }

  return body;
}

/**
 * POST /commands/:id/ack
 *
 * Acknowledge a command (mark as done).
 * Returns 404 if command not found.
 */
export async function handleAckCommand(
  db: D1Database,
  env: Env,
  request: Request,
  commandId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const found = await ackCommand(db, commandId);
  if (!found) {
    return Response.json({ error: "Command not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
