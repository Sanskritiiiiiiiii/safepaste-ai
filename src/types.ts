/**
 * A single function-level unit of code extracted from the repository.
 *
 * This is the shared currency between the chunker, the (future) indexing
 * call to the Python worker, and anything the UI shows the user — so it's
 * kept in its own file rather than buried inside astChunker.ts.
 */
export interface FunctionChunk {
  /**
   * Deterministic id: `${filePath}:${startLine}:${name}`.
   * Deliberately not a random uuid — encoding location directly in the id
   * means a chunk id is self-explanatory in logs and during debugging,
   * with no separate id registry to maintain.
   */
  id: string;
  name: string;
  /** Relative to the repo root, forward-slash separated regardless of OS. */
  filePath: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  /** 1-indexed, inclusive. */
  endLine: number;
  code: string;
}
