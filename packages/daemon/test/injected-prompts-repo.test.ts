import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { INJECTED_PROMPTS_TTL_MS } from "../src/storage/injected-prompts-schema";

describe("InjectedPromptsRepository", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newStorage(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  it("consumes one recording per identical injection", () => {
    const s = newStorage();
    const now = 1_000_000;
    const repo = s.injectedPrompts;

    repo.record("ses_a", "hash_continue", now);
    repo.record("ses_a", "hash_continue", now);

    expect(repo.consume("ses_a", "hash_continue", now)).toBe(true);
    expect(repo.consume("ses_a", "hash_continue", now)).toBe(true);
    expect(repo.consume("ses_a", "hash_continue", now)).toBe(false);
  });

  it("consume with no recording returns false", () => {
    const s = newStorage();
    const now = 1_000_000;
    const repo = s.injectedPrompts;

    expect(repo.consume("ses_a", "hash_absent", now)).toBe(false);
  });

  it("rows past the 15-minute TTL are dropped by the sweep and do not satisfy consume", () => {
    const s = newStorage();
    const now = 1_000_000;
    const repo = s.injectedPrompts;

    const expiredTime = now - INJECTED_PROMPTS_TTL_MS - 1;
    repo.record("ses_a", "hash_old", expiredTime);

    expect(repo.consume("ses_a", "hash_old", now)).toBe(false);

    const cleaned = repo.cleanupExpired(now);
    expect(cleaned).toBe(1);
    expect(repo.has("ses_a", "hash_old", now)).toBe(false);
  });

  it("has() does not decrement", () => {
    const s = newStorage();
    const now = 1_000_000;
    const repo = s.injectedPrompts;

    repo.record("ses_a", "hash_check", now);

    expect(repo.has("ses_a", "hash_check", now)).toBe(true);
    expect(repo.has("ses_a", "hash_check", now)).toBe(true);

    expect(repo.consume("ses_a", "hash_check", now)).toBe(true);
    expect(repo.has("ses_a", "hash_check", now)).toBe(false);
  });

  it("two different sessions with the same text hash do not interfere", () => {
    const s = newStorage();
    const now = 1_000_000;
    const repo = s.injectedPrompts;

    repo.record("ses_a", "hash_shared", now);
    repo.record("ses_b", "hash_shared", now);

    expect(repo.consume("ses_a", "hash_shared", now)).toBe(true);
    expect(repo.consume("ses_a", "hash_shared", now)).toBe(false);

    expect(repo.consume("ses_b", "hash_shared", now)).toBe(true);
    expect(repo.consume("ses_b", "hash_shared", now)).toBe(false);
  });
});
