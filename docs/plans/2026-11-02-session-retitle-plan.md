# Session retitle route — plan

Bead: eng-agent-platform-555.29 (child .29.2). Design reviewed by adversarial-reviewer-opus
("build with changes", folded in below).

## Why

A stall-watch coordinator that hands an idle worker its next assignment should rename the worker
after the new work: the session title (opencode or goose) and its Telegram forum topic, which
keeps the directory suffix (`<title> · ~/dir`). Today topics are write-once except for the
human-only Telegram `/rename`, and no daemon route renames a session's backend.

## Shape

```
./sw message --title  ->  daemon POST /sessions/:id/rename {title}
                           1. backend rename (goose ACP or opencode PATCH)   -- fail fast
                           2. daemon sessions.title
                           3. worker POST /topics/rename {sessionId,title,dir}
```

Order matters: the backend is renamed first because each backend caches its title and attaches it
to every later `/stop`; renaming only the daemon's DB would be reverted on the next turn.

## Task 1 — worker: `POST /topics/rename` + shared helper

Files: `packages/worker/src/topic-rename.ts` (new), `src/index.ts` (route), `src/webhook.ts`
(Telegram `/rename` uses the helper), tests in `packages/worker/test/`.

1. Helper `editTopicName(db, env, topic: TopicRow, name: string)`: `editForumTopic` on the topic
   row's own `chat_id`/`message_thread_id`; TOPIC_NOT_MODIFIED counts as success; on success
   `topics.rename(db, {sessionId, name})` (sets `name_provisional = 0`). Returns
   `{ ok: true } | { ok: false, error }`. Telegram before D1 so a retry converges (keep the
   existing comment's reasoning). The Telegram `/rename` command keeps its exact behaviour
   (bare title, also writes `sessions.label`, same replies) but calls the helper.
2. Handler `handleTopicRename(db, env, request)`:
   - `authenticate` -> 401. JSON body `{sessionId, title, dir}`; `sessionId` and `title` non-empty
     strings, `dir` string (may be empty); title that `isPlaceholderTitle` matches -> 400.
   - `sessions` row for sessionId missing -> 404 `{error:"unknown_session"}`;
     `checkActsAs(principal, env, row.machine_id)` -> its response.
   - Row in `named_topic_bindings` for the session -> 409 `{error:"bound_session"}` (coordinators
     live in named topics, which are never renamed).
   - `!topicsEnabled(env)` -> 200 `{renamed:false, reason:"topics_disabled"}`; no topic row, or
     `message_thread_id` null -> 200 `{renamed:false, reason:"no_topic"}`.
   - Otherwise name = `topicName(dir, title)`; helper fails -> 502 `{error:"telegram_failed",
     detail}`; else 200 `{renamed:true, name}`.
   - Does NOT touch `sessions.label` (daemon re-registration overwrites it anyway).
3. Route in `index.ts` next to `/topics/lookup`.

Tests: auth 401; other machine's session 403; unknown 404; bound 409; placeholder 400; topics
disabled; no topic; success edits Telegram with `<title> · ~/dir` and writes D1 name +
`name_provisional=0`; TOPIC_NOT_MODIFIED = success; Telegram failure = 502 and D1 untouched.
Existing `/rename` command tests stay green unchanged.

## Task 2 — daemon: `POST /sessions/:id/rename`

Files: `src/goose/acp-client.ts`, `src/goose/session-runner.ts`, `src/opencode-client.ts`,
`src/worker/poller.ts`, `src/session-rename.ts` (new), `src/app.ts`, `src/index.ts`, tests.

1. `GooseAcpClient.renameSession(sessionId, title)`: request
   `_goose/unstable/session/rename {sessionId, title}`; JSON-RPC error -> `GooseProtocolError`.
   Add the method to `ALLOWED_ACP_METHODS` with a human-decision comment in the style of the
   `session/cancel` one: "Human decision (2026-11-02, Jonathan): rename goose/honk sessions when a
   coordinator reassigns a worker. Renames only; executes nothing." Add to `RunnerClient`.
2. `GooseSessionRunner.rename(title)`: ensure connected (bounded by `NON_TURN_TIMEOUT_MS` via
   `withDeadline`), call `client.renameSession(backendSessionId, title)` (bounded the same), then
   `this.title = title` ONLY on success. Without the last step the next `/stop` reverts the
   title (runner attaches its cached title to every `/stop`). Works with or without a turn in
   flight; does not touch the queue.
3. `OpencodeClient.setSessionTitle(sessionId, directory, title)`: `PATCH /session/:id` body
   `{title}`, headers `x-opencode-directory: directory` + JSON; non-2xx -> `OpencodeHttpError`.
   The directory header is load-bearing: opencode delivers `session.updated` only to the plugin
   instance for that directory, and that plugin's cached title is what its `/stop`s carry.
4. `Poller.renameTopic({sessionId, title, dir}, signal)`: `POST /topics/rename`; returns the
   parsed 200 body; throws `Error("topics/rename returned <status>: <error>")` otherwise. Not
   recorded in the worker-health monitor (same as `lookupTopics`).
5. `session-rename.ts` exports `handleSessionRename(deps, sessionId, body)` returning a
   `Response`. deps: `{ storage, renameGoose?, renameOpencode?, renameTopic?, topicTimeoutMs? }`.
   - `title` via `parseTitle` (export it from app.ts or move to text.ts) -> 400 if absent.
   - session missing -> 404; `boundTopicKey` -> 409 `bound_session`; `isPullBackend` -> 409
     `pull_session`.
   - goose-acp -> `renameGoose(session, title)`; `isOpencodeRoutable(session)` ->
     `renameOpencode(session, title)`; else 409 `unsupported_backend`. Missing dep -> 503.
   - Backend throws -> 502 `{ok:false, step:"backend", error}`; DB and topic untouched.
   - `storage.sessions.setTitle(sessionId, title)`.
   - Topic: no `renameTopic` -> `topic: {status:"skipped", reason:"no_worker"}`; else call with
     `dir: session.cwd ?? ""` under an AbortSignal timeout (default 10s); worker result ->
     `topic: {status: renamed ? "renamed" : "unchanged", ...body}`; throw -> 502
     `{ok:false, step:"topic", backend:"renamed", stored:true, error}`.
   - Success 200 `{ok:true, title, backend:"renamed", stored:true, topic}`. Idempotent: rerun
     converges.
6. `app.ts`: `POST /sessions/:id/rename` (decode with the same 400-on-bad-encoding guard as
   `/read`), placed before the generic `/sessions/` block; `AppOptions.sessionRename`.
7. `index.ts` wiring: `renameGoose = (s, t) => gooseRunners.get(s).rename(t)` when
   `gooseRunners`; `renameOpencode` = `clientForSession(id)` + `await directoryForSession(id)`
   (throw if either is missing) then `client.setSessionTitle(id, dir, title)`;
   `renameTopic = poller.renameTopic`.

Tests: acp-client sends the method and the allowlist admits it; runner.rename sets the title so
the next turn's `/stop` body carries the NEW title, and a failed rename leaves the old one;
opencode client PATCH shape + header; route: 400/404/409 bound/409 pull/409 unsupported, backend
failure leaves DB title and makes no topic call, success order backend -> DB -> topic with
`dir = cwd`, topic failure 502 with stored title, no worker = skipped.

## Verification before merge

- `npm run typecheck`; `npm test -w packages/worker`; `npm test -w packages/daemon`
  (`test/routing/lease-cas-concurrency.test.ts` is a known flake).
- Live probe: `_goose/unstable/session/rename` through honkd on a throwaway session
  (ws://127.0.0.1:4280/acp), then confirm goose's session list shows the new name.
