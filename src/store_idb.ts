// The GC-4 persistent store engine (dev-docs/DecisionLog.md GAP-10): IndexedDB
// behind the SAME sync `StoreEngine` seam. The async factory preloads every
// persisted row into a per-instance memory cache; `open()` then serves
// synchronously and `append()` writes through fire-and-forget — persistence can
// degrade (quota, private mode), the app does not. Op records persist WHOLESALE
// (structured clone of the object as given), so the wire fields a session op
// carries (share/glade_id/key/refs/shape) survive the reload — which is what
// lets `SessionDestination.hydrate` re-validate the prev-hash chain exactly
// (GAP-9). `drop()` (last unmount) RETAINS the rows: instance teardown is a
// lifecycle event, not an eviction policy; `purge()` is the explicit delete.

import type { AppendOutcome, InstanceStore, StoredOp, StoreEngine } from "./store.ts";

const STORE = "ops";
const DB_VERSION = 1;

interface OpRow {
  instanceKey: string;
  origin: string;
  seq: number;
  op: StoredOp;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IdbInstanceStore implements InstanceStore {
  constructor(
    private readonly engine: IndexedDbStoreEngine,
    private readonly instanceKey: string,
    private ops: StoredOp[],
  ) {}

  append(op: StoredOp): AppendOutcome {
    // dedup by (origin, seq) — a re-delivered op is not stored twice.
    if (this.ops.some((o) => o.origin === op.origin && o.seq === op.seq)) return "duplicate";
    this.ops.push(op);
    this.engine.put({ instanceKey: this.instanceKey, origin: op.origin, seq: op.seq, op });
    return "appended";
  }

  all(): StoredOp[] {
    return this.ops.slice();
  }

  /** engine-internal: purge empties the live view too. */
  clear(): void {
    this.ops = [];
  }
}

export class IndexedDbStoreEngine implements StoreEngine {
  private readonly pending = new Set<Promise<unknown>>();

  private constructor(
    private readonly db: IDBDatabase,
    private readonly cache: Map<string, IdbInstanceStore>,
  ) {}

  /** Open (or create) the database and preload every persisted op into the
   *  cache, preserving the sync `StoreEngine` seam. The factory is injectable
   *  (fake-indexeddb in tests); the default is the browser's `indexedDB`. */
  static async open(dbName = "glial", factory: IDBFactory = indexedDB): Promise<IndexedDbStoreEngine> {
    const openReq = factory.open(dbName, DB_VERSION);
    openReq.onupgradeneeded = () => {
      openReq.result.createObjectStore(STORE, { keyPath: ["instanceKey", "origin", "seq"] });
    };
    const db = await req(openReq);
    const rows = await req<OpRow[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<OpRow[]>);
    // group per instance, straight into each live view — no re-writes of what
    // was just read (rows arrive in key order: instance, origin, seq).
    const byInstance = new Map<string, StoredOp[]>();
    for (const row of rows) {
      let ops = byInstance.get(row.instanceKey);
      if (!ops) byInstance.set(row.instanceKey, (ops = []));
      ops.push(row.op);
    }
    const engine = new IndexedDbStoreEngine(db, new Map());
    for (const [key, ops] of byInstance) engine.cache.set(key, new IdbInstanceStore(engine, key, ops));
    return engine;
  }

  open(instanceKey: string): InstanceStore {
    let s = this.cache.get(instanceKey);
    if (!s) {
      s = new IdbInstanceStore(this, instanceKey, []);
      this.cache.set(instanceKey, s);
    }
    return s;
  }

  /** Instance teardown (last unmount). Persisted ops are RETAINED — the decl's
   *  retention policy, not the refcount, decides eviction (GAP-10; TTL/quota
   *  enforcement deferred). The cache stays too: a later remount must re-open
   *  synchronously. */
  drop(_instanceKey: string): void {}

  /** Explicitly delete an instance's persisted ops (the eviction primitive).
   *  The cache is complete by construction (preload + write-through, no
   *  eviction), so its keys enumerate every row — no IDBKeyRange needed
   *  (that global is DOM-only; the injectable seam is just the factory). */
  async purge(instanceKey: string): Promise<void> {
    const cached = this.cache.get(instanceKey);
    if (!cached) return;
    const ops = cached.all();
    cached.clear();
    const store = this.db.transaction(STORE, "readwrite").objectStore(STORE);
    await Promise.all(ops.map((o) => req(store.delete([instanceKey, o.origin, o.seq]))));
  }

  /** Await every in-flight write-through (tests; best-effort before teardown). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  close(): void {
    this.db.close();
  }

  /** store-internal write-through: fire-and-forget, tracked for flush(). */
  put(row: OpRow): void {
    try {
      const p = req(this.db.transaction(STORE, "readwrite").objectStore(STORE).put(row)).catch(() => {
        // persistence degrades (quota, closed db); memory keeps serving.
      });
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    } catch {
      // transaction refused (db closing): same stance.
    }
  }
}
