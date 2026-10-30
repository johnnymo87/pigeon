import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import {
  REMOTE_LAUNCH_REQUEST_TTL_MS,
  REMOTE_LAUNCH_DEADLINE_GRACE_MS,
  initRemoteLaunchSchema,
  RemoteLaunchRepository,
} from "../src/storage/remote-launch-repo";

describe("RemoteLaunchRepository", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newDb(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  describe("constants", () => {
    it("exports standard TTL and deadline grace constants", () => {
      expect(REMOTE_LAUNCH_REQUEST_TTL_MS).toBe(15 * 60_000);
      expect(REMOTE_LAUNCH_DEADLINE_GRACE_MS).toBe(180_000); // 60s lease + 120s buffer
    });
  });

  describe("inbound (machine B side)", () => {
    it("inserts received record and retrieves it", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      const inserted = repo.insertReceived(
        { fromMachine: "devbox", launchId: "l1", fromSession: "ses_client1" },
        1_000,
      );
      expect(inserted).toBe(true);

      const record = repo.get("devbox", "l1");
      expect(record).toEqual({
        fromMachine: "devbox",
        launchId: "l1",
        fromSession: "ses_client1",
        state: "received",
        sessionId: null,
        outcome: null,
        reason: null,
        ackDone: false,
        ackAttempts: 0,
        nextAckAt: null,
        receivedAt: 1_000,
        updatedAt: 1_000,
      });
    });

    it("is idempotent on (from_machine, launch_id) conflict", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      expect(
        repo.insertReceived(
          { fromMachine: "devbox", launchId: "l1", fromSession: "ses_client1" },
          1_000,
        ),
      ).toBe(true);
      expect(
        repo.insertReceived(
          { fromMachine: "devbox", launchId: "l1", fromSession: "ses_client2" },
          2_000,
        ),
      ).toBe(false);

      const record = repo.get("devbox", "l1");
      expect(record?.fromSession).toBe("ses_client1");
      expect(record?.receivedAt).toBe(1_000);
    });

    it("markCreated only transitions from 'received' state", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      repo.insertReceived(
        { fromMachine: "devbox", launchId: "l1", fromSession: "ses_client1" },
        1_000,
      );

      // Successfully transitions from received -> created
      expect(repo.markCreated("devbox", "l1", "ses_spawned1", 1_500)).toBe(true);

      const record = repo.get("devbox", "l1");
      expect(record?.state).toBe("created");
      expect(record?.sessionId).toBe("ses_spawned1");
      expect(record?.updatedAt).toBe(1_500);

      // Fails if called again when already in 'created' state
      expect(repo.markCreated("devbox", "l1", "ses_spawned2", 2_000)).toBe(false);
      expect(repo.get("devbox", "l1")?.sessionId).toBe("ses_spawned1");

      // Non-existent row returns false
      expect(repo.markCreated("devbox", "unknown", "ses_x", 2_000)).toBe(false);
    });

    it("settle transitions from 'received' or 'created' to 'settled'", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      // Settle directly from received (e.g. refusal or directory error)
      repo.insertReceived(
        { fromMachine: "devbox", launchId: "l_refused", fromSession: "ses_client" },
        1_000,
      );
      expect(
        repo.settle("devbox", "l_refused", "refused", null, "no_such_directory", 1_200),
      ).toBe(true);

      let record = repo.get("devbox", "l_refused");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("refused");
      expect(record?.sessionId).toBeNull();
      expect(record?.reason).toBe("no_such_directory");
      expect(record?.updatedAt).toBe(1_200);

      // Settle from created (normal launch success)
      repo.insertReceived(
        { fromMachine: "devbox", launchId: "l_ok", fromSession: "ses_client" },
        2_000,
      );
      repo.markCreated("devbox", "l_ok", "ses_target", 2_100);
      expect(repo.settle("devbox", "l_ok", "launched", "ses_target", null, 2_200)).toBe(true);

      record = repo.get("devbox", "l_ok");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("launched");
      expect(record?.sessionId).toBe("ses_target");
      expect(record?.reason).toBeNull();

      // Settle on already settled row returns false
      expect(repo.settle("devbox", "l_ok", "launched", "ses_target", null, 2_300)).toBe(false);
    });

    it("markAckDone and markAckRetry update ack status and enforce ack_done=0", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      repo.insertReceived(
        { fromMachine: "devbox", launchId: "l1", fromSession: "ses_client" },
        1_000,
      );
      repo.settle("devbox", "l1", "launched", "ses_target", null, 1_100);

      // Retry when ack_done = 0 succeeds
      expect(repo.markAckRetry("devbox", "l1", 5_000, 1_200)).toBe(true);
      let record = repo.get("devbox", "l1");
      expect(record?.ackAttempts).toBe(1);
      expect(record?.nextAckAt).toBe(5_000);
      expect(record?.updatedAt).toBe(1_200);

      // Second retry succeeds
      expect(repo.markAckRetry("devbox", "l1", 10_000, 5_500)).toBe(true);
      record = repo.get("devbox", "l1");
      expect(record?.ackAttempts).toBe(2);
      expect(record?.nextAckAt).toBe(10_000);

      // Mark done succeeds when ack_done = 0
      expect(repo.markAckDone("devbox", "l1", 10_500)).toBe(true);
      record = repo.get("devbox", "l1");
      expect(record?.ackDone).toBe(true);
      expect(record?.updatedAt).toBe(10_500);

      // Further markAckDone or markAckRetry calls return false once ack_done = 1
      expect(repo.markAckDone("devbox", "l1", 11_000)).toBe(false);
      expect(repo.markAckRetry("devbox", "l1", 15_000, 11_000)).toBe(false);
      expect(repo.get("devbox", "l1")?.ackAttempts).toBe(2);
    });

    it("listAcksDue returns settled rows with ack_done=0 and next_ack_at <= now", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      // Row 1: received, not settled -> not due
      repo.insertReceived({ fromMachine: "devbox", launchId: "l1", fromSession: "s" }, 1_000);

      // Row 2: settled, ack_done=0, next_ack_at=null -> due
      repo.insertReceived({ fromMachine: "devbox", launchId: "l2", fromSession: "s" }, 1_000);
      repo.settle("devbox", "l2", "launched", "ses_1", null, 1_100);

      // Row 3: settled, ack_done=0, next_ack_at in future -> not due
      repo.insertReceived({ fromMachine: "devbox", launchId: "l3", fromSession: "s" }, 1_000);
      repo.settle("devbox", "l3", "launched", "ses_2", null, 1_100);
      repo.markAckRetry("devbox", "l3", 5_000, 1_200);

      // Row 4: settled, ack_done=0, next_ack_at in past -> due
      repo.insertReceived({ fromMachine: "devbox", launchId: "l4", fromSession: "s" }, 1_000);
      repo.settle("devbox", "l4", "refused", null, "invalid", 1_100);
      repo.markAckRetry("devbox", "l4", 1_500, 1_200);

      // Row 5: settled, ack_done=1 -> not due
      repo.insertReceived({ fromMachine: "devbox", launchId: "l5", fromSession: "s" }, 1_000);
      repo.settle("devbox", "l5", "launched", "ses_3", null, 1_100);
      repo.markAckDone("devbox", "l5", 1_200);

      const due = repo.listAcksDue(2_000, 10);
      expect(due.map((r) => r.launchId).sort()).toEqual(["l2", "l4"]);

      // Respects limit
      const limited = repo.listAcksDue(2_000, 1);
      expect(limited).toHaveLength(1);
    });

    it("pruneOlderThan deletes inbound rows with updated_at < cutoff", () => {
      const s = newDb();
      const repo = s.remoteLaunch.inbound;

      repo.insertReceived({ fromMachine: "devbox", launchId: "l_old", fromSession: "s" }, 1_000);
      repo.settle("devbox", "l_old", "launched", "ses_1", null, 1_500);

      repo.insertReceived({ fromMachine: "devbox", launchId: "l_new", fromSession: "s" }, 10_000);

      const deleted = repo.pruneOlderThan(5_000);
      expect(deleted).toBe(1);
      expect(repo.get("devbox", "l_old")).toBeNull();
      expect(repo.get("devbox", "l_new")).not.toBeNull();
    });
  });

  describe("outbound (machine A side)", () => {
    it("inserts outbound row and computes request_expires_at and deadline_at", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      const inserted = repo.insert(
        {
          launchId: "l1",
          fromSession: "ses_caller",
          toMachine: "cloudbox",
          directory: "~/projects/pigeon",
          requestJson: JSON.stringify({ prompt: "hello" }),
          createdAt: 1_000_000,
        },
      );
      expect(inserted).toBe(true);

      const record = repo.get("l1");
      expect(record).toEqual({
        launchId: "l1",
        fromSession: "ses_caller",
        toMachine: "cloudbox",
        directory: "~/projects/pigeon",
        requestJson: JSON.stringify({ prompt: "hello" }),
        state: "sending",
        resolvedOutcome: null,
        refusalCode: null,
        refusalStatus: null,
        refusalDetail: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: 1_000_000,
        requestExpiresAt: 1_000_000 + REMOTE_LAUNCH_REQUEST_TTL_MS,
        deadlineAt: 1_000_000 + REMOTE_LAUNCH_REQUEST_TTL_MS + REMOTE_LAUNCH_DEADLINE_GRACE_MS,
        settledAt: null,
      });

      // Duplicate insert returns false and does not overwrite
      expect(
        repo.insert({
          launchId: "l1",
          fromSession: "ses_diff",
          toMachine: "macbook",
          directory: "~/diff",
          requestJson: "{}",
          createdAt: 2_000_000,
        }),
      ).toBe(false);
      expect(repo.get("l1")?.fromSession).toBe("ses_caller");
    });

    it("markAccepted only succeeds from state='sending'", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      repo.insert({
        launchId: "l1",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markRetry("l1", 2_000);

      // markAccepted succeeds from state='sending'
      expect(repo.markAccepted("l1")).toBe(true);
      const record = repo.get("l1");
      expect(record?.state).toBe("accepted");
      expect(record?.nextAttemptAt).toBeNull();

      // markAccepted returns false if state is already 'accepted'
      expect(repo.markAccepted("l1")).toBe(false);

      // markAccepted returns false if state is 'resolved'
      repo.markResolved("l1", "launched", 3_000);
      expect(repo.markAccepted("l1")).toBe(false);
    });

    it("markRefused only succeeds from state='sending'", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      repo.insert({
        launchId: "l1",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });

      // markRefused succeeds from state='sending'
      expect(repo.markRefused("l1", "target_offline", 503, "cloudbox is not polling", 2_500)).toBe(true);
      const record = repo.get("l1");
      expect(record?.state).toBe("refused");
      expect(record?.resolvedOutcome).toBe("refused");
      expect(record?.refusalCode).toBe("target_offline");
      expect(record?.refusalStatus).toBe(503);
      expect(record?.refusalDetail).toBe("cloudbox is not polling");
      expect(record?.settledAt).toBe(2_500);

      // markRefused returns false if state is already 'refused'
      expect(repo.markRefused("l1", "target_offline", 503, "retry refusal", 3_000)).toBe(false);

      // Cannot refuse a resolved or accepted row
      repo.insert({
        launchId: "l2",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markAccepted("l2");
      expect(repo.markRefused("l2", "queue_full", 429, "full", 2_000)).toBe(false);
      expect(repo.get("l2")?.state).toBe("accepted");
    });

    it("markRetry only succeeds from state='sending'", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      repo.insert({
        launchId: "l1",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });

      expect(repo.markRetry("l1", 6_000)).toBe(true);
      let record = repo.get("l1");
      expect(record?.attempts).toBe(1);
      expect(record?.nextAttemptAt).toBe(6_000);
      expect(record?.state).toBe("sending");

      repo.markRetry("l1", 12_000);
      record = repo.get("l1");
      expect(record?.attempts).toBe(2);
      expect(record?.nextAttemptAt).toBe(12_000);

      // Once accepted or settled, markRetry returns false
      repo.markAccepted("l1");
      expect(repo.markRetry("l1", 18_000)).toBe(false);
      expect(repo.get("l1")?.state).toBe("accepted");
      expect(repo.get("l1")?.attempts).toBe(2);
    });

    it("markDeadline only succeeds from state IN ('sending', 'accepted')", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      // 1. From 'sending'
      repo.insert({
        launchId: "l1",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      expect(repo.markDeadline("l1", 50_000)).toBe(true);
      let record = repo.get("l1");
      expect(record?.state).toBe("deadline");
      expect(record?.resolvedOutcome).toBe("unconfirmed");
      expect(record?.settledAt).toBe(50_000);

      // Repeat deadline returns false
      expect(repo.markDeadline("l1", 60_000)).toBe(false);

      // 2. From 'accepted'
      repo.insert({
        launchId: "l2",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markAccepted("l2");
      expect(repo.markDeadline("l2", 50_000)).toBe(true);
      expect(repo.get("l2")?.state).toBe("deadline");

      // 3. Negative guard: deadline after resolved returns false and leaves row resolved
      repo.insert({
        launchId: "l3",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markResolved("l3", "launched", 2_000);
      expect(repo.markDeadline("l3", 50_000)).toBe(false);
      record = repo.get("l3");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("launched");

      // 4. Negative guard: deadline after refused returns false and leaves row refused
      repo.insert({
        launchId: "l4",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markRefused("l4", "invalid", 400, "bad", 2_000);
      expect(repo.markDeadline("l4", 50_000)).toBe(false);
      record = repo.get("l4");
      expect(record?.state).toBe("refused");
      expect(record?.resolvedOutcome).toBe("refused");
    });

    it("markResolved sets state='resolved' and never downgrades terminal outcomes", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      // Settle from sending
      repo.insert({
        launchId: "l1",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      expect(repo.markResolved("l1", "launched", 3_000)).toBe(true);
      let record = repo.get("l1");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("launched");
      expect(record?.settledAt).toBe(3_000);

      // Upgrades from deadline (unconfirmed) to launched / refused succeed
      repo.insert({
        launchId: "l2",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markDeadline("l2", 50_000);
      expect(repo.get("l2")?.resolvedOutcome).toBe("unconfirmed");

      expect(repo.markResolved("l2", "launched", 55_000)).toBe(true);
      record = repo.get("l2");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("launched");
      expect(record?.settledAt).toBe(55_000);

      // NEVER DOWNGRADE: if outcome is already 'launched', incoming 'unconfirmed' is rejected
      expect(repo.markResolved("l2", "unconfirmed", 60_000)).toBe(false);
      record = repo.get("l2");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("launched");

      // NEVER DOWNGRADE: if outcome is already 'refused', incoming 'unconfirmed' is rejected
      repo.insert({
        launchId: "l3",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markResolved("l3", "refused", 2_000);
      expect(repo.markResolved("l3", "unconfirmed", 3_000)).toBe(false);
      record = repo.get("l3");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("refused");
    });

    it("markResolved records a first 'unconfirmed' result on a row with no outcome yet", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;
      repo.insert({
        launchId: "l4",
        fromSession: "ses_c",
        toMachine: "cloudbox",
        directory: "dir",
        requestJson: "{}",
        createdAt: 1_000,
      });
      repo.markAccepted("l4");
      // resolved_outcome IS NULL here: a NULL-unsafe predicate would skip the update.
      expect(repo.markResolved("l4", "unconfirmed", 2_000)).toBe(true);
      const record = repo.get("l4");
      expect(record?.state).toBe("resolved");
      expect(record?.resolvedOutcome).toBe("unconfirmed");
      // and a later correction still upgrades it
      expect(repo.markResolved("l4", "launched", 3_000)).toBe(true);
      expect(repo.get("l4")?.resolvedOutcome).toBe("launched");
    });

    it("listSendDue returns sending rows where next_attempt_at <= now and request_expires_at > now", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;
      const now = 100_000;

      // 1. sending, next_attempt_at is null, not expired -> due
      repo.insert({ launchId: "l1", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: now - 1000 });

      // 2. sending, next_attempt_at in past, not expired -> due
      repo.insert({ launchId: "l2", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: now - 5000 });
      repo.markRetry("l2", now - 1000);

      // 3. sending, next_attempt_at in future -> not due
      repo.insert({ launchId: "l3", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: now - 5000 });
      repo.markRetry("l3", now + 10_000);

      // 4. accepted -> not due
      repo.insert({ launchId: "l4", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: now - 1000 });
      repo.markAccepted("l4");

      // 5. expired: request_expires_at <= now -> not due
      repo.insert({
        launchId: "l5",
        fromSession: "s",
        toMachine: "m",
        directory: "d",
        requestJson: "{}",
        createdAt: now - REMOTE_LAUNCH_REQUEST_TTL_MS - 10,
      });

      const due = repo.listSendDue(now);
      expect(due.map((r) => r.launchId).sort()).toEqual(["l1", "l2"]);
    });

    it("listDeadlinePassed returns sending or accepted rows with deadline_at <= now", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;
      const now = 2_000_000;

      // Row 1: accepted, deadline in past -> due
      repo.insert({
        launchId: "l1",
        fromSession: "s",
        toMachine: "m",
        directory: "d",
        requestJson: "{}",
        createdAt: now - (REMOTE_LAUNCH_REQUEST_TTL_MS + REMOTE_LAUNCH_DEADLINE_GRACE_MS) - 100,
      });
      repo.markAccepted("l1");

      // Row 2: sending, deadline in past -> due
      repo.insert({
        launchId: "l2",
        fromSession: "s",
        toMachine: "m",
        directory: "d",
        requestJson: "{}",
        createdAt: now - (REMOTE_LAUNCH_REQUEST_TTL_MS + REMOTE_LAUNCH_DEADLINE_GRACE_MS) - 50,
      });

      // Row 3: accepted, deadline in future -> not due
      repo.insert({
        launchId: "l3",
        fromSession: "s",
        toMachine: "m",
        directory: "d",
        requestJson: "{}",
        createdAt: now - 1000,
      });
      repo.markAccepted("l3");

      // Row 4: already settled (deadline) -> not due
      repo.insert({
        launchId: "l4",
        fromSession: "s",
        toMachine: "m",
        directory: "d",
        requestJson: "{}",
        createdAt: now - (REMOTE_LAUNCH_REQUEST_TTL_MS + REMOTE_LAUNCH_DEADLINE_GRACE_MS) - 100,
      });
      repo.markDeadline("l4", now - 50);

      const passed = repo.listDeadlinePassed(now);
      expect(passed.map((r) => r.launchId).sort()).toEqual(["l1", "l2"]);
    });

    it("pruneOlderThan deletes outbound rows with created_at < cutoff", () => {
      const s = newDb();
      const repo = s.remoteLaunch.outbound;

      repo.insert({ launchId: "l_old", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: 1_000 });
      repo.insert({ launchId: "l_new", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: 10_000 });

      const deleted = repo.pruneOlderThan(5_000);
      expect(deleted).toBe(1);
      expect(repo.get("l_old")).toBeNull();
      expect(repo.get("l_new")).not.toBeNull();
    });
  });

  describe("results seen (machine A dedup)", () => {
    it("records a result ID once and returns false on duplicate", () => {
      const s = newDb();
      const repo = s.remoteLaunch.resultsSeen;

      expect(repo.record("r:1", "l1", 1_000)).toBe(true);
      expect(repo.record("r:1", "l1", 2_000)).toBe(false);

      const record = repo.get("r:1");
      expect(record).toEqual({
        resultId: "r:1",
        launchId: "l1",
        receivedAt: 1_000,
      });
    });

    it("pruneOlderThan deletes results seen with received_at < cutoff", () => {
      const s = newDb();
      const repo = s.remoteLaunch.resultsSeen;

      repo.record("r:old", "l1", 1_000);
      repo.record("r:new", "l2", 10_000);

      const deleted = repo.pruneOlderThan(5_000);
      expect(deleted).toBe(1);
      expect(repo.get("r:old")).toBeNull();
      expect(repo.get("r:new")).not.toBeNull();
    });
  });

  describe("top-level pruneOlderThan on RemoteLaunchRepository", () => {
    it("prunes all three tables", () => {
      const s = newDb();

      s.remoteLaunch.inbound.insertReceived({ fromMachine: "m", launchId: "l_in", fromSession: "s" }, 1_000);
      s.remoteLaunch.outbound.insert({ launchId: "l_out", fromSession: "s", toMachine: "m", directory: "d", requestJson: "{}", createdAt: 1_000 });
      s.remoteLaunch.resultsSeen.record("r:seen", "l_out", 1_000);

      const counts = s.remoteLaunch.pruneOlderThan(5_000);
      expect(counts).toEqual({ inbound: 1, outbound: 1, resultsSeen: 1 });

      expect(s.remoteLaunch.inbound.get("m", "l_in")).toBeNull();
      expect(s.remoteLaunch.outbound.get("l_out")).toBeNull();
      expect(s.remoteLaunch.resultsSeen.get("r:seen")).toBeNull();
    });
  });
});
