/**
 * SafePaste AI — stdio protocol types.
 *
 * Every message crossing the extension <-> Python worker boundary uses this
 * envelope. `type` decides what `payload`/`result` contain — the envelope
 * itself never changes when we add new features (see ARCHITECTURE.md).
 */

import { FunctionChunk } from './types';

export interface RequestMessage<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
}

export interface SuccessResponse<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
}

export interface ErrorResponse {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ResponseMessage<TResult = unknown> =
  | SuccessResponse<TResult>
  | ErrorResponse;

/**
 * Milestone 0's only message type. Proves the pipe works before we build
 * anything real on top of it (indexing, duplicate detection, etc).
 */
export interface PingPayload {
  message: string;
}

export interface PingResult {
  pong: true;
  received: string;
}

/**
 * Milestone 2: semantic duplicate detection.
 */
export interface IndexPayload {
  storageDir: string;
  chunks: FunctionChunk[];
}

export interface IndexResult {
  chunksIndexed: number;
  /**
   * Ids of chunks that could not be embedded even after sanitization
   * (see embedder.py). Still indexed with a placeholder vector so counts
   * stay consistent, but they'll never meaningfully match anything —
   * worth surfacing to the user rather than hiding.
   */
  failedChunks: string[];
}

export interface CheckDuplicatesPayload {
  storageDir: string;
  code: string;
  topK?: number;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity, roughly 0 (unrelated) to 1 (identical). */
  similarity: number;
}

export interface CheckDuplicatesResult {
  matches: DuplicateMatch[];
}
