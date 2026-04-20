export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1_000) return String(Math.floor(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
