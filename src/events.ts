// The rich change event glial emits per instance (GlialClientRuntime rule 3).
// The wire-shaped SHELL is glade-decl's `ChangeEvent` (GC-1 ruling: the generic
// envelope lives in glade-decl; each shape's DELTA payload schema lives in its
// taut-shape contract, carried opaquely). For binder v0 the opaque `payload`
// bytes use an interim glial encoding (dev-docs/DecisionLog.md GAP-5); the
// decoded fields below are glial's convenience so a consumer can pick delta vs
// refresh against its live UI state without decoding the shell.

import type { ChangeEvent, GladeId } from "@owebeeone/glade-decl";
import type { LogRecord } from "./folds/log.ts";
import { fromUtf8, utf8 } from "./bytes.ts";

export interface InstanceEvent {
  /** The glade-decl envelope shell (grip-core types events without glial). */
  envelope: ChangeEvent;
  /** value shape: the whole assembled value (undefined when empty). */
  value?: Uint8Array;
  /** value shape: true when no write has landed yet. */
  empty?: boolean;
  /** log shape: the whole assembled record list (present on refresh). */
  records?: LogRecord[];
  /** log shape: records appended since baseSeq (present on delta). */
  delta?: LogRecord[];
}

// Interim v0 payload encoding for the opaque shell (GAP-5). value → raw value
// bytes; log → a JSON line-list of {seq, text?}. Real per-shape delta schemas
// land in taut-shape.
function encodeLog(records: LogRecord[]): Uint8Array {
  return utf8(JSON.stringify(records.map((r) => ({ seq: r.seq, text: fromUtf8(r.payload) }))));
}

export function valueRefresh(
  gladeId: GladeId,
  origin: string | null,
  seq: number | null,
  value: Uint8Array | null,
): InstanceEvent {
  const envelope: ChangeEvent = {
    glade_id: gladeId,
    shape: "value",
    kind: "refresh",
    base_seq: seq != null ? BigInt(seq) : null,
    origin_meta: origin != null && seq != null ? { origin, seq: BigInt(seq) } : null,
    payload: value ?? new Uint8Array(),
  };
  return value == null ? { envelope, empty: true } : { envelope, value };
}

export function logRefresh(gladeId: GladeId, records: LogRecord[]): InstanceEvent {
  return {
    envelope: {
      glade_id: gladeId,
      shape: "log",
      kind: "refresh",
      base_seq: BigInt(records.length),
      origin_meta: null,
      payload: encodeLog(records),
    },
    records,
  };
}

export function logDelta(gladeId: GladeId, baseSeq: number, delta: LogRecord[], whole: LogRecord[]): InstanceEvent {
  return {
    envelope: {
      glade_id: gladeId,
      shape: "log",
      kind: "delta",
      base_seq: BigInt(baseSeq),
      origin_meta: null,
      payload: encodeLog(delta),
    },
    delta,
    records: whole,
  };
}
