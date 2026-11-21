/**
 * Shared fixtures for tests of transport-agnostic behaviour (topic CAS, holds, notifications,
 * named topics, the reaper, ...), which run against SLACK now that it is the only transport
 * (pigeon-4ogz.13).
 *
 * Two ways to give such a test a provider:
 *
 * - A Slack workspace: `mkSlackMachine` + `envWith` + the `slack()` fetchMock helper, with the
 *   handlers called directly (`postJson`). Used when the test goes through a route handler, which
 *   builds its own transport from the env.
 * - A fake transport: `fakeTransport` handed to `resolveTopic`/`resolveNamedTopic`/the reaper as
 *   `transport`, with `slack:` chat ids. Used when the test wants to script exact provider
 *   results (a 5xx, a rate limit, a thread that vanished) or count calls.
 *
 * Every test owns its machine, team and session ids: the D1 tables are shared by the whole run.
 */
import { env, fetchMock } from "cloudflare:test";
import { sha256Hex } from "../src/credentials";
import { slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import type { ChatTransport } from "../src/chat/transport";
import { finalize, reserve } from "../src/topics";

let counter = 0;
export const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

export interface SlackMachine {
  machineId: string;
  key: string;
  ws: SlackWorkspace;
}

/** A machine with a real credential and a workspace of its own. */
export async function mkSlackMachine(opts: { teamId?: string; domain?: string } = {}): Promise<SlackMachine> {
  const machineId = `h${stamp()}`.toLowerCase().slice(0, 30);
  const key = ("pgk_" + machineId + "x".repeat(43)).slice(0, 47);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
  const ws: SlackWorkspace = {
    teamId: opts.teamId ?? `T${stamp()}`.toUpperCase(),
    appId: "A0APP",
    domain: opts.domain ?? "acme",
    botToken: "xoxb-bot",
    userToken: "xoxp-user",
    signingSecret: "sig",
    ownerUserId: "U0OWNER",
  };
  return { machineId, key, ws };
}

/**
 * The worker env with these machines' workspace secrets (and whatever else the test sets). Topics
 * are on: that flag is `TELEGRAM_TOPICS_ENABLED` until the Telegram deletion makes them always on
 * (this line is then the only thing to remove here).
 */
export function envWith(machines: SlackMachine[], extra: Record<string, unknown> = {}): Env {
  const secrets: Record<string, string> = {};
  for (const m of machines) secrets[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  return { ...env, TELEGRAM_TOPICS_ENABLED: "true", ...secrets, ...extra } as unknown as Env;
}

export function postJson(path: string, key: string, body: unknown): Request {
  return new Request(`https://worker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

// ─── Slack Web API mock ────────────────────────────────────────────────────

export interface SlackCall {
  method: string;
  params: URLSearchParams;
}
export const slackCalls: SlackCall[] = [];
export const resetSlackCalls = () => {
  slackCalls.length = 0;
};

type Reply = Record<string, unknown> | ((params: URLSearchParams) => Record<string, unknown>);

/** One expected Slack Web API call, answered with `reply`. */
export function slack(method: string, reply: Reply, status = 200, headers?: Record<string, string>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(
      status,
      (opts: { body?: unknown }) => {
        const params = new URLSearchParams(String(opts.body));
        slackCalls.push({ method, params });
        return typeof reply === "function" ? reply(params) : reply;
      },
      headers ? { headers } : undefined,
    );
}

export const slackOf = (method: string) => slackCalls.filter((c) => c.method === method);

/** `chat.postMessage` success body. */
export const posted = (channel = "C1", ts = "1700000000.000100") => ({ ok: true, ts, channel });

/** The calls a brand-new session conversation costs: create, invite, set topic. */
export function slackCreate(channelId: string, name = "chan") {
  slack("conversations.create", { ok: true, channel: { id: channelId, name } });
  slack("conversations.invite", { ok: true });
  slack("conversations.setTopic", { ok: true });
}

// ─── D1 fixtures ───────────────────────────────────────────────────────────

export async function seedSession(machineId: string, label = "harness"): Promise<string> {
  const sessionId = `ses_${String(++counter).padStart(4, "0")}hz${Date.now().toString(36)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(sessionId, machineId, label, now, now)
    .run();
  return sessionId;
}

/** A conversation this team already has, returning its handle. */
export async function seedChannel(teamId: string, channelId: string): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(teamId, channelId)
    .first<{ handle: number }>();
  return row!.handle;
}

/** A session whose topic row already lives in this workspace, over a conversation Slack knows. */
export async function seedSlackTopic(sessionId: string, machineId: string, ws: SlackWorkspace, name = "s") {
  const channelId = `CSESS${stamp()}`.toUpperCase();
  const handle = await seedChannel(ws.teamId, channelId);
  await reserve(env.DB, { sessionId, machineId, chatId: slackChatId(ws), name });
  await finalize(env.DB, { sessionId, chatId: slackChatId(ws), messageThreadId: handle, name, provisional: false });
  return { channelId, handle };
}

// ─── Fake transport ────────────────────────────────────────────────────────

type Handler = (o: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

const METHODS = [
  "sendMessage",
  "sendRichMessage",
  "editMessageText",
  "sendPhoto",
  "sendDocument",
  "createForumTopic",
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
  "deleteForumTopic",
  "unpinAllForumTopicMessages",
] as const;

/**
 * A scripted ChatTransport. A method with no handler succeeds (a create answers thread 1; a send
 * answers an incrementing message id); a handler returns the ChatResult (or a promise of one),
 * and may throw. `calls` records each method's options in order.
 */
export function fakeTransport(handlers: Partial<Record<(typeof METHODS)[number], Handler>> = {}) {
  const calls: Record<string, any[]> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of METHODS) calls[m] = [];
  let nextMessageId = 1;
  const defaults: Record<(typeof METHODS)[number], Handler> = {
    sendMessage: () => ({ ok: true, result: { message_id: nextMessageId++ } }),
    sendRichMessage: () => ({ ok: true, result: { message_id: nextMessageId++ } }),
    editMessageText: () => ({ ok: true, result: true }),
    sendPhoto: () => ({ ok: true, result: { message_id: nextMessageId++ } }),
    sendDocument: () => ({ ok: true, result: { message_id: nextMessageId++ } }),
    createForumTopic: (o) => ({ ok: true, result: { message_thread_id: 1, name: o.name, icon_color: 0 } }),
    editForumTopic: () => ({ ok: true, result: true }),
    closeForumTopic: () => ({ ok: true, result: true }),
    reopenForumTopic: () => ({ ok: true, result: true }),
    deleteForumTopic: () => ({ ok: true, result: true }),
    unpinAllForumTopicMessages: () => ({ ok: true, result: true }),
  };
  const client = {} as Record<string, Handler>;
  for (const m of METHODS) {
    client[m] = async (o: unknown) => {
      calls[m]!.push(o);
      return (handlers[m] ?? defaults[m])(o);
    };
  }
  return { client: client as unknown as ChatTransport, calls };
}

/** Results a fake transport answers with, in the ChatResult shapes the real transports produce. */
export const results = {
  ok: <T>(result: T) => ({ ok: true as const, result }),
  threadNotFound: () => ({ ok: false as const, kind: "thread_not_found" as const }),
  notModified: () => ({ ok: false as const, kind: "topic_not_modified" as const }),
  rateLimited: (retryAfter: number) => ({ ok: false as const, kind: "rate_limited" as const, retryAfter }),
  error: (errorCode: number, description: string, response?: unknown) => ({
    ok: false as const,
    kind: "error" as const,
    errorCode,
    description,
    response: response ?? { ok: false, error_code: errorCode, description },
  }),
};

/** The workspace's `#alerts`, already known, so an unthreaded post is one chat.postMessage. */
export async function seedAlerts(ws: SlackWorkspace): Promise<string> {
  const channelId = `CALERTS${stamp()}`.toUpperCase();
  const handle = await seedChannel(ws.teamId, channelId);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, '_alerts', ?, 'alerts', NULL, NULL, 0, 0)`,
  )
    .bind(slackChatId(ws), handle)
    .run();
  return channelId;
}

// ─── A stateful fake Slack ─────────────────────────────────────────────────

/** A scripted HTTP answer for `FakeSlack.script`: a bare object is a 200 body. */
export type Scripted =
  | Record<string, unknown>
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { throws: string };
// (a string `body` is sent as it is, for a gateway's HTML error page)

const isHttp = (r: Scripted): r is { status: number; body: unknown; headers?: Record<string, string> } =>
  typeof (r as { status?: unknown }).status === "number" && "body" in r;
const isThrow = (r: Scripted): r is { throws: string } => typeof (r as { throws?: unknown }).throws === "string";

export interface FakeSlack {
  /** Channels created through `conversations.create`, in order. */
  created: Array<{ id: string; name: string }>;
  /** Channel ids the fake answers `channel_not_found` for (a conversation deleted out of band). */
  gone: Set<string>;
  /** Channel ids the fake answers `is_archived` for until `conversations.unarchive`. */
  archived: Set<string>;
  /** Queue answers for one method; they are used, oldest first, before the default behaviour. */
  script(method: string, ...answers: Scripted[]): void;
  /** Every call of `method`, in order. */
  of(method: string): SlackCall[];
  /** The `channel` param of each `chat.postMessage`, in order. */
  postedTo(): string[];
}

const SLACK_METHODS = [
  "conversations.create",
  "conversations.invite",
  "conversations.setTopic",
  "conversations.join",
  "conversations.archive",
  "conversations.unarchive",
  "conversations.info",
  "conversations.rename",
  "conversations.list",
  "chat.postMessage",
  "chat.update",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
] as const;

/**
 * Installs persistent interceptors for the Slack methods the transport uses, behaving like a
 * workspace that works: channels are created, posts succeed, archive/unarchive succeed. State a
 * test cares about (a deleted channel, an archived one, a failing method) is set through the
 * returned object. Pair with `afterEach(() => fetchMock.get("https://slack.com").cleanMocks())`.
 */
export function fakeSlack(): FakeSlack {
  const created: FakeSlack["created"] = [];
  const gone = new Set<string>();
  const archived = new Set<string>();
  const scripts = new Map<string, Scripted[]>();
  let nextChannel = 1;
  let nextTs = 1;
  const slackReply = (method: string, params: URLSearchParams): Scripted => {
    const channel = params.get("channel") ?? "";
    switch (method) {
      case "conversations.create": {
        const id = `CFAKE${stamp().toUpperCase()}${nextChannel++}`;
        const name = params.get("name") ?? "";
        created.push({ id, name });
        return { ok: true, channel: { id, name } };
      }
      case "conversations.list":
        return { ok: true, channels: [], response_metadata: {} };
      case "conversations.info":
        return { ok: true, channel: { name: "chan", topic: { value: "" } } };
      case "conversations.unarchive":
        archived.delete(channel);
        return { ok: true };
      case "conversations.archive":
        if (gone.has(channel)) return { ok: false, error: "channel_not_found" };
        archived.add(channel);
        return { ok: true };
      case "chat.postMessage":
      case "chat.update":
        if (gone.has(channel)) return { ok: false, error: "channel_not_found" };
        if (archived.has(channel)) return { ok: false, error: "is_archived" };
        return { ok: true, ts: `1700000000.${String(nextTs++).padStart(6, "0")}`, channel };
      case "files.getUploadURLExternal":
        return { ok: true, upload_url: "https://files.slack.com/upload/v1/FAKE", file_id: `FFAKE${nextTs++}` };
      case "files.completeUploadExternal":
        return { ok: true, files: [{ id: "FFAKE" }] };
      default:
        return { ok: true };
    }
  };
  for (const method of SLACK_METHODS) {
    fetchMock
      .get("https://slack.com")
      .intercept({ method: "POST", path: `/api/${method}` })
      .reply((opts: { body?: unknown }) => {
        const params = new URLSearchParams(String(opts.body));
        slackCalls.push({ method, params });
        const next = scripts.get(method)?.shift();
        const answer = next ?? slackReply(method, params);
        // A transport failure: the fetch itself rejects.
        if (isThrow(answer)) throw new Error(answer.throws);
        if (isHttp(answer)) {
          return {
            statusCode: answer.status,
            data: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
            responseOptions: { headers: { "Content-Type": "application/json", ...(answer.headers ?? {}) } },
          };
        }
        return {
          statusCode: 200,
          data: JSON.stringify(answer),
          responseOptions: { headers: { "Content-Type": "application/json" } },
        };
      })
      .persist();
  }
  fetchMock
    .get("https://files.slack.com")
    .intercept({ method: "POST", path: /^\/upload\// })
    .reply(200, "OK - 1")
    .persist();
  return {
    created,
    gone,
    archived,
    script: (method, ...answers) => {
      const queue = scripts.get(method) ?? [];
      queue.push(...answers);
      scripts.set(method, queue);
    },
    of: slackOf,
    postedTo: () => slackOf("chat.postMessage").map((c) => c.params.get("channel") ?? ""),
  };
}
