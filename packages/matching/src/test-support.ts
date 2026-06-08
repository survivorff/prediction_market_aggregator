/**
 * Test-support utilities for the matching engine — **not for production use.**
 *
 * Layer 2 ({@link scoreCandidates}) talks only to the provider-agnostic
 * {@link EmbeddingProvider} port. Production wires a real embedding model behind
 * that port; tests wire {@link BagOfWordsEmbeddingProvider}, a deterministic,
 * dependency-free embedding so similarity scoring is fully reproducible without
 * a model or network. It is exported (clearly marked) so every matching test —
 * including Layer 3 calibration tests (task 6.3) — can share one fake provider.
 *
 * The embedding is a hashing bag-of-words: each lowercase word token is hashed
 * into one of `dimensions` buckets and its (sublinear) count accumulated. Two
 * questions that share words therefore have overlapping support and a high
 * cosine similarity; questions with no shared words are (modulo hash
 * collisions) orthogonal. This is intentionally simple and order-insensitive —
 * enough to exercise threshold gating and ranking deterministically, not a
 * model of real semantics.
 */

import type { EmbeddingProvider } from "./layer2-similarity.js";

/** Default embedding dimensionality for {@link BagOfWordsEmbeddingProvider}. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 64;

/** Split text into lowercase alphanumeric word tokens. */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ?? [];
}

/**
 * Deterministic FNV-1a hash of a token folded into `[0, dimensions)`.
 * (FNV-1a: stable, fast, well-distributed for short strings.)
 */
function hashToken(token: string, dimensions: number): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % dimensions;
}

/**
 * A deterministic, in-memory {@link EmbeddingProvider} for tests.
 *
 * Same text → same vector, every run, with no external dependencies. Shared
 * words drive cosine similarity up; disjoint vocabularies stay near-orthogonal.
 * Implements the optional `embedAll` batch path so the batch seam in
 * {@link embedTexts} is exercised too.
 */
export class BagOfWordsEmbeddingProvider implements EmbeddingProvider {
  /** Number of times {@link embed} has been invoked (test assertions). */
  embedCalls = 0;
  /** Number of times {@link embedAll} has been invoked (test assertions). */
  embedAllCalls = 0;

  constructor(private readonly dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS) {}

  /** Pure vector construction (no call counting) so batch + single agree. */
  private vectorFor(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const bucket = hashToken(token, this.dimensions);
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
    // Sublinear (1 + log count) damping so a word repeated many times does not
    // dominate; purely deterministic.
    for (let i = 0; i < vec.length; i += 1) {
      const count = vec[i] ?? 0;
      vec[i] = count > 0 ? 1 + Math.log(count) : 0;
    }
    return vec;
  }

  embed(text: string): Promise<number[]> {
    this.embedCalls += 1;
    return Promise.resolve(this.vectorFor(text));
  }

  embedAll(texts: string[]): Promise<number[][]> {
    this.embedAllCalls += 1;
    return Promise.resolve(texts.map((t) => this.vectorFor(t)));
  }
}
