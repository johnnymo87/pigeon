export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1_000) return String(Math.floor(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type MessageTokenInfo = {
  id: string
  sessionID: string
  role: string
  tokens?: TokenTotals
  providerID?: string
  modelID?: string
}

export type TokenSnapshot = {
  messageId: string
  total: number
  providerID: string
  modelID: string
}

function totalTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

export class TokenTracker {
  private snapshots = new Map<string, TokenSnapshot>()

  onMessageUpdated(info: MessageTokenInfo): void {
    if (info.role !== "assistant") return
    if (!info.tokens) return
    if (info.tokens.output <= 0) return
    if (!info.providerID || !info.modelID) return

    this.snapshots.set(info.sessionID, {
      messageId: info.id,
      total: totalTokens(info.tokens),
      providerID: info.providerID,
      modelID: info.modelID,
    })
  }

  getSnapshot(sessionID: string): TokenSnapshot | undefined {
    return this.snapshots.get(sessionID)
  }

  clear(sessionID: string): void {
    this.snapshots.delete(sessionID)
  }

  async getFooter(sessionID: string, client: SdkLike, cache: ProviderCache): Promise<string> {
    const snap = this.snapshots.get(sessionID)
    if (!snap || snap.total <= 0) return ""

    const tokens = formatTokenCount(snap.total)
    const limit = await cache.getContextLimit(client, snap.providerID, snap.modelID)
    if (!limit || limit <= 0) {
      return `📊 ${tokens} tokens`
    }
    const percent = Math.round((snap.total / limit) * 100)
    return `📊 ${tokens} tokens · ${percent}%`
  }
}

type ConfigProvidersResponse = {
  data?: {
    providers: Array<{
      id: string
      models: Record<string, { limit?: { context?: number } }>
    }>
  }
}

type SdkLike = {
  config: {
    providers: () => Promise<ConfigProvidersResponse>
  }
}

type LogFn = (message: string) => void

export class ProviderCache {
  private limits = new Map<string, number>() // key = `${providerID}/${modelID}`
  private loaded = false
  private failureLogged = false

  constructor(private log: LogFn = () => {}) {}

  async getContextLimit(client: SdkLike, providerID: string, modelID: string): Promise<number | undefined> {
    const key = `${providerID}/${modelID}`
    if (this.limits.has(key)) return this.limits.get(key)
    const wasLoaded = this.loaded
    if (!wasLoaded) {
      // Cold start: one refresh, no fallthrough. (Fallthrough would double-fetch
      // when the model isn't in the response.) Concurrent callers at cold start
      // may each trigger their own refresh; that's tolerable since `loaded`
      // flips true on first success and subsequent callers short-circuit via
      // the cache-hit fast path above.
      await this.refresh(client)
      return this.limits.get(key)
    }
    // Already loaded but key missing: the providers list may have changed since
    // startup, so try one more refresh. Worst case is one extra HTTP call per
    // stop notification for a persistently-unknown model — acceptable given the
    // low call rate (one per turn) and that providerID/modelID originate from
    // the same server that serves providers().
    await this.refresh(client)
    return this.limits.get(key)
  }

  private async refresh(client: SdkLike): Promise<void> {
    try {
      const res = await client.config.providers()
      const providers = res?.data?.providers ?? []
      for (const p of providers) {
        for (const [modelID, model] of Object.entries(p.models ?? {})) {
          const ctx = model?.limit?.context
          if (typeof ctx === "number" && ctx > 0) {
            this.limits.set(`${p.id}/${modelID}`, ctx)
          }
        }
      }
      // Only set on success; transient failures fall through to `catch` and
      // leave `loaded` false so the next call retries.
      this.loaded = true
    } catch (err) {
      if (!this.failureLogged) {
        this.failureLogged = true
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`token-tracker: provider list fetch failed: ${msg}`)
      }
    }
  }
}
