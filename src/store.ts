// The store-engine seam — persistence is glial's, owned per binding instance
// (GlialClientRuntime rule 1: "persistence first"; the client store is glial's,
// not the tap's and not glade's). The in-memory engine is the degenerate
// destination every instance gets for free; the IndexedDB engine (store_idb.ts)
// slots in behind this same interface (GC-4) with no instance/binder change.

export interface StoredOp {
  origin: string;
  seq: number;
  lamport: number;
  prev: Uint8Array | null;
  payload: Uint8Array;
}

/** Whether an append landed — the SEMANTIC echo/dedup guard (GAP-9): callers
 *  fold-and-broadcast only on "appended", so a re-delivered op (a wire echo,
 *  a replayed duplicate) is a no-op while genuine catch-up folds. */
export type AppendOutcome = "appended" | "duplicate";

/** One instance's local op-log destination. */
export interface InstanceStore {
  append(op: StoredOp): AppendOutcome;
  all(): StoredOp[];
}

/** Opens per-instance stores by a stable instance key. `drop` signals instance
 *  TEARDOWN (last unmount) — whether that deletes anything is the engine's
 *  retention call: memory frees, the persistent engine retains (GAP-10). */
export interface StoreEngine {
  open(instanceKey: string): InstanceStore;
  drop(instanceKey: string): void;
}

class MemoryInstanceStore implements InstanceStore {
  private ops: StoredOp[] = [];
  append(op: StoredOp): AppendOutcome {
    // dedup by (origin, seq) — a re-delivered op is not stored twice.
    if (this.ops.some((o) => o.origin === op.origin && o.seq === op.seq)) return "duplicate";
    this.ops.push(op);
    return "appended";
  }
  all(): StoredOp[] {
    return this.ops.slice();
  }
}

/** The default destination: memory now, IndexedDB later — same seam (GC-4). */
export class MemoryStoreEngine implements StoreEngine {
  private stores = new Map<string, MemoryInstanceStore>();
  open(instanceKey: string): InstanceStore {
    let s = this.stores.get(instanceKey);
    if (!s) {
      s = new MemoryInstanceStore();
      this.stores.set(instanceKey, s);
    }
    return s;
  }
  drop(instanceKey: string): void {
    this.stores.delete(instanceKey);
  }
}
