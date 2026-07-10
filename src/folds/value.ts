// The `value` fold (lww register) — glial's own assembly, gated byte-for-byte
// against taut-shape's value oracle (`corpus/value.v0.json`, 11 vectors). The
// winner is max by (lamport, origin); writes dedup by (origin, seq); a forked
// (origin, seq) — same slot, different payload or prev — is equivocation and
// leaves the register unchanged (the glade lww discipline, TautShapeOracle).
//
// This is intentionally a fresh implementation living INSIDE glial (rule 2:
// "assembly happens inside glial"), not an import of the session's fold — the
// corpus is what proves the two agree.

import { bytesEq } from "../bytes.ts";

export interface ValueOp {
  origin: string;
  seq: number;
  lamport: number;
  prev: Uint8Array | null;
  payload: Uint8Array;
}

export interface Winner {
  origin: string;
  seq: number;
  lamport: number;
}

export type ValueState =
  | { state: "empty" }
  | { state: "data"; value: Uint8Array; winner: Winner };

/** Outcome of accepting a write, so a caller can surface equivocation. */
export type SetOutcome = "accepted" | "duplicate" | "equivocation";

function prevEq(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return bytesEq(a, b);
}

export class ValueRegister {
  // key `${origin}\x00${seq}` -> accepted op
  private ops = new Map<string, ValueOp>();

  /** Fold one write. Idempotent on an exact re-send; a forked slot is rejected
   *  (equivocation) and the register is left unchanged. */
  set(op: ValueOp): SetOutcome {
    const k = `${op.origin}\x00${op.seq}`;
    const prior = this.ops.get(k);
    if (prior) {
      if (!bytesEq(prior.payload, op.payload) || !prevEq(prior.prev, op.prev)) {
        return "equivocation";
      }
      return "duplicate";
    }
    this.ops.set(k, op);
    return "accepted";
  }

  /** The current lww projection: empty until a write lands. */
  read(): ValueState {
    let win: ValueOp | undefined;
    for (const o of this.ops.values()) {
      if (!win || o.lamport > win.lamport || (o.lamport === win.lamport && o.origin > win.origin)) {
        win = o;
      }
    }
    if (!win) return { state: "empty" };
    return {
      state: "data",
      value: win.payload,
      winner: { origin: win.origin, seq: win.seq, lamport: win.lamport },
    };
  }
}
