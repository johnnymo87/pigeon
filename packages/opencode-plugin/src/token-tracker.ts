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
}
