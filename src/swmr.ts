/** Glade SWMR payload adapter + canonical Taut assembly.
 *
 * `Op.origin` is the authenticated writer id. The first two payload bytes are
 * `glade.swmr.adapter/v1`; the body is passed opaquely to `swmr.oracle/v1`.
 */

import { SwmrNode, type SwmrInput, type SwmrOutput } from "@owebeeone/taut-shape";
import type { StoredOp } from "./store.ts";

export const SWMR_ADAPTER_VERSION = 1;
export type GlialSwmrAction = "snapshot" | "delta" | "reset";

const TAGS: Readonly<Record<GlialSwmrAction, number>> = Object.freeze({
  snapshot: 0,
  delta: 1,
  reset: 2,
});

export class SwmrAdapterError extends Error {
  readonly code = "GLIAL_SWMR_INVALID";
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "SwmrAdapterError";
    this.reason = reason;
  }
}

export function encodeSwmrAction(
  action: GlialSwmrAction,
  body: Uint8Array = new Uint8Array(),
): Uint8Array {
  const out = new Uint8Array(2 + body.length);
  out[0] = SWMR_ADAPTER_VERSION;
  out[1] = TAGS[action];
  out.set(body, 2);
  return out;
}

export function decodeSwmrAction(payload: Uint8Array): {
  action: GlialSwmrAction;
  body: Uint8Array;
} {
  if (payload.length < 2) {
    throw new SwmrAdapterError("invalid_action", "SWMR action envelope is shorter than two bytes");
  }
  if (payload[0] !== SWMR_ADAPTER_VERSION) {
    throw new SwmrAdapterError("invalid_action", `unsupported SWMR adapter version ${payload[0]}`);
  }
  const action = (["snapshot", "delta", "reset"] as const)[payload[1]];
  if (action === undefined) {
    throw new SwmrAdapterError("invalid_action", `unsupported SWMR action tag ${payload[1]}`);
  }
  return { action, body: payload.slice(2) };
}

export interface SwmrAssembly {
  readonly state: "empty" | "data" | "reset";
  readonly writerId: string | null;
  readonly epoch: bigint;
  readonly seq: bigint | null;
  readonly snapshot: Uint8Array | null;
  readonly deltas: readonly Uint8Array[];
  /** The v1 file profile treats every snapshot/delta body as a full image. */
  readonly value: Uint8Array | null;
  readonly lastAction: GlialSwmrAction | null;
  readonly resetDetail: Uint8Array | null;
}

function diagnostic(outputs: readonly SwmrOutput[]): Extract<SwmrOutput, { type: "diagnostic" }> | undefined {
  return outputs.find((output): output is Extract<SwmrOutput, { type: "diagnostic" }> => output.type === "diagnostic");
}

/** Replay the op-set through the canonical `SwmrNode`. No caller state mutates. */
export function assembleSwmr(ops: readonly StoredOp[], swmrId: string): SwmrAssembly {
  const ordered = [...ops].sort((a, b) => a.seq - b.seq || a.lamport - b.lamport);
  const node = new SwmrNode({ stopWhen: "explicit_only" });
  let writerId: string | null = null;
  let lastAction: GlialSwmrAction | null = null;
  let resetDetail: Uint8Array | null = null;

  for (const op of ordered) {
    const decoded = decodeSwmrAction(op.payload);
    const input: SwmrInput = decoded.action === "snapshot"
      ? { type: "snapshot_push", writer_id: op.origin, payload: decoded.body }
      : decoded.action === "delta"
        ? { type: "delta_push", writer_id: op.origin, payload: decoded.body }
        : {
            type: "reset",
            writer_id: op.origin,
            reason: "producer_requested",
            detail: decoded.body.length === 0 ? null : decoded.body,
          };
    const rejected = diagnostic(node.handle(input));
    if (rejected) {
      throw new SwmrAdapterError(rejected.code, `canonical SWMR assembly rejected ${decoded.action}: ${rejected.code}`);
    }
    writerId ??= op.origin;
    lastAction = decoded.action;
    if (decoded.action === "reset") resetDetail = decoded.body.length === 0 ? null : decoded.body;
  }

  const outputs = node.handle({
    type: "read",
    swmr_id: swmrId,
    stream_id: "glial-probe",
    cursor: null,
    timeout_ms: 0n,
  });
  const response = outputs.find(
    (output): output is Extract<SwmrOutput, { type: "read_response" }> => output.type === "read_response",
  );
  if (!response) throw new SwmrAdapterError("internal", "canonical SWMR probe did not answer");

  const snapshot = response.snapshot?.payload.slice() ?? null;
  const deltas = response.deltas.map((delta) => delta.payload.slice());
  const value = deltas.at(-1)?.slice() ?? snapshot?.slice() ?? null;
  return {
    state: value !== null ? "data" : lastAction === "reset" ? "reset" : "empty",
    writerId,
    epoch: node.epoch,
    seq: response.next_cursor?.seq ?? null,
    snapshot,
    deltas,
    value,
    lastAction,
    resetDetail,
  };
}

export interface FileWindowRequest {
  readonly from: number;
  readonly length: number;
}

export interface FileWindow {
  readonly from: number;
  readonly length: number;
  readonly total: number;
  readonly bytes: Uint8Array;
  readonly revision: string;
}

/** Project one bounded, generation-coherent window from a full-image profile. */
export function projectFileWindow(assembly: SwmrAssembly, request: FileWindowRequest): FileWindow {
  if (!Number.isSafeInteger(request.from) || request.from < 0) {
    throw new RangeError("file window from must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(request.length) || request.length < 0) {
    throw new RangeError("file window length must be a non-negative safe integer");
  }
  const source = assembly.value ?? new Uint8Array();
  const from = Math.min(request.from, source.length);
  const end = Math.min(source.length, from + request.length);
  return {
    from,
    length: end - from,
    total: source.length,
    bytes: source.slice(from, end),
    revision: `${assembly.epoch}:${assembly.seq ?? assembly.state}`,
  };
}
