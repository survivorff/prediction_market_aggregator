import { describe, it, expect } from "vitest";
import type { Market, ResolutionCriteria } from "@pma/core";
import { AUTO_CONFIRM_THRESHOLD, type ScoredMarket } from "./layer2-similarity.js";
import {
  DEFAULT_HIGH_VALUE_VOLUME,
  DEFAULT_HIGH_VALUE_LIQUIDITY,
  canonicalPairKey,
  isHighValue,
  calibrationGate,
  recordCalibrationDecision,
  InMemoryCalibrationQueue,
  InMemoryMatchLabelStore,
  type CalibrationItem,
} from "./layer3-calibration.js";

/**
 * Unit tests for Layer-3 calibration (task 6.3): the calibration gate routing
 * (auto-confirm vs. enqueue, never auto-linking ambiguous/high-value pairs —
 * Req 11.2), the high-value heuristic, recording a human decision as labeled
 * data idempotently on the canonical pair and dequeuing it (Req 11.4), and the
 * in-memory reference adapters' contract (canonical pair-key, FIFO, readback).
 *
 * Validates: Requirements 11.2, 11.4
 */

// --- fixtures --------------------------------------------------------------

function criteria(): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {} };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m-1",
    sourceId: "src-1",
    eventId: null,
    canonicalEventId: null,
    externalId: "ext-1",
    question: "Will it happen?",
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    ...overrides,
  };
}

function scored(m: Market, similarity: number): ScoredMarket {
  return { market: m, similarity };
}

// --- canonicalPairKey ------------------------------------------------------

describe("canonicalPairKey", () => {
  it("orders ids lexicographically and is orientation-independent", () => {
    const ab = canonicalPairKey("a", "b");
    const ba = canonicalPairKey("b", "a");
    expect(ab.marketAId).toBe("a");
    expect(ab.marketBId).toBe("b");
    expect(ab.key).toBe(ba.key);
    expect(ba.marketAId).toBe("a");
    expect(ba.marketBId).toBe("b");
  });

  it("handles equal ids", () => {
    const p = canonicalPairKey("x", "x");
    expect(p.marketAId).toBe("x");
    expect(p.marketBId).toBe("x");
  });
});

// --- isHighValue -----------------------------------------------------------

describe("isHighValue", () => {
  it("is true when combined 24h volume meets the threshold", () => {
    const c = market({ id: "c", volume24h: DEFAULT_HIGH_VALUE_VOLUME / 2 });
    const b = scored(market({ id: "b", volume24h: DEFAULT_HIGH_VALUE_VOLUME / 2 }), 0.99);
    expect(isHighValue(c, b)).toBe(true);
  });

  it("is true when combined liquidity meets the threshold", () => {
    const c = market({ id: "c", liquidity: DEFAULT_HIGH_VALUE_LIQUIDITY });
    const b = scored(market({ id: "b", liquidity: 0 }), 0.99);
    expect(isHighValue(c, b)).toBe(true);
  });

  it("is false for small/empty markets and treats null metrics as 0", () => {
    const c = market({ id: "c", volume24h: null, liquidity: null });
    const b = scored(market({ id: "b", volume24h: 10, liquidity: 10 }), 0.99);
    expect(isHighValue(c, b)).toBe(false);
  });

  it("honors custom thresholds", () => {
    const c = market({ id: "c", volume24h: 60 });
    const b = scored(market({ id: "b", volume24h: 60 }), 0.99);
    expect(isHighValue(c, b, { volumeThreshold: 100 })).toBe(true);
    expect(isHighValue(c, b, { volumeThreshold: 1000 })).toBe(false);
  });
});

// --- calibrationGate -------------------------------------------------------

describe("calibrationGate", () => {
  it("returns NoMatch when there is no best candidate", async () => {
    const queue = new InMemoryCalibrationQueue();
    const decision = await calibrationGate(market(), null, { queue });
    expect(decision.kind).toBe("NoMatch");
    expect(await queue.size()).toBe(0);
  });

  it("enqueues (does NOT auto-link) a below-auto-confirm pair", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c" });
    const best = scored(market({ id: "b" }), AUTO_CONFIRM_THRESHOLD - 0.05);

    const decision = await calibrationGate(candidate, best, { queue });

    expect(decision.kind).toBe("PendingCalibration");
    if (decision.kind === "PendingCalibration") {
      expect(decision.item.reasons).toContain("below-threshold");
      expect(decision.item.reasons).not.toContain("high-value");
    }
    expect(await queue.size()).toBe(1);
    const peeked = await queue.peek();
    expect(peeked?.candidate.id).toBe("c");
    expect(peeked?.best.market.id).toBe("b");
  });

  it("enqueues (does NOT auto-link) a high-value pair even above the threshold", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c", volume24h: DEFAULT_HIGH_VALUE_VOLUME });
    // Confident similarity, but high combined volume → still human review.
    const best = scored(market({ id: "b", volume24h: DEFAULT_HIGH_VALUE_VOLUME }), 0.99);

    const decision = await calibrationGate(candidate, best, { queue });

    expect(decision.kind).toBe("PendingCalibration");
    if (decision.kind === "PendingCalibration") {
      expect(decision.item.reasons).toContain("high-value");
      expect(decision.item.reasons).not.toContain("below-threshold");
    }
    expect(await queue.size()).toBe(1);
  });

  it("records both reasons when below-threshold AND high-value", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c", volume24h: DEFAULT_HIGH_VALUE_VOLUME });
    const best = scored(market({ id: "b", volume24h: DEFAULT_HIGH_VALUE_VOLUME }), 0.5);

    const decision = await calibrationGate(candidate, best, { queue });

    expect(decision.kind).toBe("PendingCalibration");
    if (decision.kind === "PendingCalibration") {
      expect(decision.item.reasons).toEqual(
        expect.arrayContaining(["below-threshold", "high-value"]),
      );
    }
  });

  it("auto-confirms a confident, non-high-value pair without enqueuing", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c", volume24h: 10 });
    const best = scored(market({ id: "b", volume24h: 10 }), AUTO_CONFIRM_THRESHOLD);

    const decision = await calibrationGate(candidate, best, { queue });

    expect(decision.kind).toBe("AutoConfirm");
    if (decision.kind === "AutoConfirm") {
      expect(decision.best.market.id).toBe("b");
    }
    expect(await queue.size()).toBe(0);
  });

  it("optionally records an auto label on auto-confirm", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    const candidate = market({ id: "c" });
    const best = scored(market({ id: "b" }), 0.97);

    await calibrationGate(candidate, best, { queue, labels }, { recordAutoLabel: true });

    const label = await labels.get("c", "b");
    expect(label).not.toBeNull();
    expect(label?.decision).toBe("same");
    expect(label?.labeledBy).toBe("auto");
    expect(label?.similarity).toBeCloseTo(0.97, 12);
  });

  it("does not record an auto label by default", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    await calibrationGate(market({ id: "c" }), scored(market({ id: "b" }), 0.97), {
      queue,
      labels,
    });
    expect(await labels.list()).toEqual([]);
  });

  it("honors a custom auto-confirm threshold", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c", volume24h: 1 });
    const best = scored(market({ id: "b", volume24h: 1 }), 0.7);

    const decision = await calibrationGate(
      candidate,
      best,
      { queue },
      {
        autoConfirmThreshold: 0.6,
      },
    );
    expect(decision.kind).toBe("AutoConfirm");
  });

  it("honors an injected high-value predicate", async () => {
    const queue = new InMemoryCalibrationQueue();
    const candidate = market({ id: "c" });
    const best = scored(market({ id: "b" }), 0.99);

    // Custom predicate forces every pair to be high-value.
    const decision = await calibrationGate(
      candidate,
      best,
      { queue },
      {
        isHighValue: () => true,
      },
    );
    expect(decision.kind).toBe("PendingCalibration");
  });
});

// --- recordCalibrationDecision ---------------------------------------------

describe("recordCalibrationDecision", () => {
  it("persists a human label and dequeues the pair", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    const item: CalibrationItem = {
      candidate: market({ id: "c" }),
      best: scored(market({ id: "b" }), 0.8),
      reasons: ["below-threshold"],
    };
    await queue.enqueue(item);
    expect(await queue.size()).toBe(1);

    const label = await recordCalibrationDecision(
      { marketAId: "c", marketBId: "b", decision: "same" },
      { queue, labels },
    );

    expect(label.decision).toBe("same");
    expect(label.labeledBy).toBe("human");
    // Similarity defaulted from the queued item.
    expect(label.similarity).toBeCloseTo(0.8, 12);
    // Dequeued.
    expect(await queue.size()).toBe(0);
    // Readable back.
    expect(await labels.get("c", "b")).toEqual(label);
  });

  it("stores 'different' verdicts too", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    await recordCalibrationDecision(
      { marketAId: "a", marketBId: "b", decision: "different", similarity: 0.6 },
      { queue, labels },
    );
    const label = await labels.get("a", "b");
    expect(label?.decision).toBe("different");
    expect(label?.similarity).toBeCloseTo(0.6, 12);
  });

  it("is idempotent on the canonical pair: same pair twice → one row, (A,B)==(B,A)", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();

    await recordCalibrationDecision(
      { marketAId: "b", marketBId: "a", decision: "same", similarity: 0.7 },
      { queue, labels },
    );
    // Resolve the same pair in the opposite orientation with a new verdict.
    await recordCalibrationDecision(
      { marketAId: "a", marketBId: "b", decision: "different", similarity: 0.65 },
      { queue, labels },
    );

    const all = await labels.list();
    expect(all).toHaveLength(1);
    // Latest write wins; ids canonicalized to (a, b).
    expect(all[0]?.marketAId).toBe("a");
    expect(all[0]?.marketBId).toBe("b");
    expect(all[0]?.decision).toBe("different");
  });

  it("stores null similarity when the pair was not queued and none supplied", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    const label = await recordCalibrationDecision(
      { marketAId: "a", marketBId: "b", decision: "same" },
      { queue, labels },
    );
    expect(label.similarity).toBeNull();
  });

  it("removes the queued item regardless of orientation", async () => {
    const queue = new InMemoryCalibrationQueue();
    const labels = new InMemoryMatchLabelStore();
    await queue.enqueue({
      candidate: market({ id: "a" }),
      best: scored(market({ id: "b" }), 0.8),
      reasons: ["high-value"],
    });
    await recordCalibrationDecision(
      { marketAId: "b", marketBId: "a", decision: "same" },
      { queue, labels },
    );
    expect(await queue.size()).toBe(0);
  });
});

// --- InMemoryCalibrationQueue contract -------------------------------------

describe("InMemoryCalibrationQueue", () => {
  it("enqueue is idempotent on the canonical pair (one entry, either orientation)", async () => {
    const queue = new InMemoryCalibrationQueue();
    const first: CalibrationItem = {
      candidate: market({ id: "a" }),
      best: scored(market({ id: "b" }), 0.8),
      reasons: ["below-threshold"],
    };
    // Re-enqueue in the opposite orientation with an updated similarity.
    const second: CalibrationItem = {
      candidate: market({ id: "b" }),
      best: scored(market({ id: "a" }), 0.85),
      reasons: ["high-value"],
    };
    await queue.enqueue(first);
    await queue.enqueue(second);

    expect(await queue.size()).toBe(1);
    const items = await queue.list();
    expect(items[0]?.reasons).toEqual(["high-value"]);
  });

  it("lists pending items oldest-first (FIFO)", async () => {
    const queue = new InMemoryCalibrationQueue();
    await queue.enqueue({
      candidate: market({ id: "a" }),
      best: scored(market({ id: "z1" }), 0.8),
      reasons: ["below-threshold"],
    });
    await queue.enqueue({
      candidate: market({ id: "c" }),
      best: scored(market({ id: "z2" }), 0.8),
      reasons: ["below-threshold"],
    });
    const items = await queue.list();
    expect(items.map((i) => i.candidate.id)).toEqual(["a", "c"]);
    expect((await queue.peek())?.candidate.id).toBe("a");
  });

  it("remove returns null for an unknown pair", async () => {
    const queue = new InMemoryCalibrationQueue();
    expect(await queue.remove("x", "y")).toBeNull();
  });
});

// --- InMemoryMatchLabelStore contract --------------------------------------

describe("InMemoryMatchLabelStore", () => {
  it("put canonicalizes ids and get reads back order-independently", async () => {
    const store = new InMemoryMatchLabelStore();
    const saved = await store.put({
      marketAId: "z",
      marketBId: "a",
      decision: "same",
      similarity: 0.9,
      labeledBy: "human",
    });
    expect(saved.marketAId).toBe("a");
    expect(saved.marketBId).toBe("z");
    expect(await store.get("a", "z")).toEqual(saved);
    expect(await store.get("z", "a")).toEqual(saved);
  });

  it("list returns all labels (training data)", async () => {
    const store = new InMemoryMatchLabelStore();
    await store.put({
      marketAId: "a",
      marketBId: "b",
      decision: "same",
      similarity: null,
      labeledBy: "human",
    });
    await store.put({
      marketAId: "c",
      marketBId: "d",
      decision: "different",
      similarity: 0.5,
      labeledBy: "auto",
    });
    expect(await store.list()).toHaveLength(2);
  });
});
