/**
 * SafePaste AI — stdio protocol types.
 *
 * Every message crossing the extension <-> Python worker boundary uses this
 * envelope. `type` decides what `payload`/`result` contain — the envelope
 * itself never changes when we add new features (see ARCHITECTURE.md).
 */

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
