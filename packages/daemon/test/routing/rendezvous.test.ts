import { describe, expect, it } from "vitest";
import { pickServe, rankServes } from "../../src/routing/rendezvous";

describe("Uniform Rendezvous Hashing (HRW)", () => {
  const serves = ["serve-0", "serve-1", "serve-2", "serve-3"];

  it("should be deterministic", () => {
    const sessionId = "session-abc-123";

    // Repeated pickServe calls return the same winner
    const firstPick = pickServe(sessionId, serves);
    expect(firstPick).toBeDefined();
    for (let i = 0; i < 10; i++) {
      expect(pickServe(sessionId, serves)).toBe(firstPick);
    }

    // Repeated rankServes calls return the exact same ranking
    const firstRank = rankServes(sessionId, serves);
    for (let i = 0; i < 10; i++) {
      expect(rankServes(sessionId, serves)).toEqual(firstRank);
    }
  });

  it("should exhibit minimal reshuffle property (HRW property)", () => {
    const sessionId = "session-abc-123";
    const ranking = rankServes(sessionId, serves);
    const winner = ranking[0];
    
    // Find a serve that is NOT the winner
    const nonWinner = serves.find(s => s !== winner)!;
    
    // Create a reduced candidates set without the non-winner
    const reducedServes = serves.filter(s => s !== nonWinner);
    
    // The winner must remain unchanged
    const newWinner = pickServe(sessionId, reducedServes);
    expect(newWinner).toBe(winner);
  });

  it("should promote the next-ranked serve when the winner is removed", () => {
    const sessionId = "session-abc-123";
    const ranking = rankServes(sessionId, serves);
    const winner = ranking[0];
    const secondPlace = ranking[1];
    
    // Create a reduced candidates set without the winner
    const reducedServes = serves.filter(s => s !== winner);
    
    // The new winner must be the second place serve
    const newWinner = pickServe(sessionId, reducedServes);
    expect(newWinner).toBe(secondPlace);
  });

  it("should return undefined for empty candidates list", () => {
    expect(pickServe("session-abc-123", [])).toBeUndefined();
    expect(rankServes("session-abc-123", [])).toEqual([]);
  });

  it("should have a sane uniform distribution over 1000 sessions", () => {
    const counts: Record<string, number> = {
      "serve-0": 0,
      "serve-1": 0,
      "serve-2": 0,
      "serve-3": 0,
    };

    for (let i = 0; i < 1000; i++) {
      const sessionId = `session-${i}`;
      const winner = pickServe(sessionId, serves);
      expect(winner).toBeDefined();
      expect(serves).toContain(winner);
      counts[winner!] = (counts[winner!] || 0) + 1;
    }

    // Every serve should win at least 150 sessions (rough even spread)
    for (const s of serves) {
      expect(counts[s]).toBeGreaterThanOrEqual(150);
    }
  });

  it("should resolve ties deterministically (tie-break determinism)", () => {
    // ranking the same inputs twice yields identical arrays
    const sessionId = "session-tie-break";
    const ranking1 = rankServes(sessionId, serves);
    const ranking2 = rankServes(sessionId, serves);
    expect(ranking1).toEqual(ranking2);
  });
});
