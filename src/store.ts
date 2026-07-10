// The store-engine seam — persistence is glial's, owned per binding instance
// (GlialClientRuntime rule 1: "persistence first"; the client store is glial's,
// not the tap's and not glade's). The in-memory engine is the degenerate
// destination every instance gets for free; an IndexedDB engine slots in behind
// this same interface later (GC-4) with no instance/binder change.

export interface StoredOp {
  origin: string;
  seq: number;
  lamport: number;
  prev: Uint8Array | null;
  payload: Uint8Array;
}

/** One instance's local op-log destination. */
export interface InstanceStore {
  append(op: StoredOp): void;
  all(): StoredOp[];
}

/** Opens per-instance stores by a stable instance key; drops them on teardown. */
export interface StoreEngine {
  open(instanceKey: string): InstanceStore;
  drop(instanceKey: string): void;
}

class MemoryInstanceStore implements InstanceStore {
  private ops: StoredOp[] = [];
  append(op: StoredOp): void {
    // dedup by (origin, seq) — a re-delivered op is not stored twice.
    if (this.ops.some((o) => o.origin === op.origin && o.seq === op.seq)) return;
    this.ops.push(op);
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
