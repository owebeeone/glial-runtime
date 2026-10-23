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
const CHECKPOINTS = "checkpoints";
const DB_VERSION = 2;

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

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

class IdbInstanceStore implements InstanceStore {
  constructor(
    private readonly engine: IndexedDbStoreEngine,
    private readonly instanceKey: string,
    private ops: StoredOp[],
    private checkpoint?: unknown,
  ) {}

  append(op: StoredOp): AppendOutcome {
    // dedup by (origin, seq) — a re-delivered op is not stored twice.
    if (this.ops.some((o) => o.origin === op.origin && o.seq === op.seq)) { return "duplicate"; }
    this.ops.push(op);
    this.engine.put({ instanceKey: this.instanceKey, origin: op.origin, seq: op.seq, op });
    return "appended";
  }

  all(): StoredOp[] {
    return this.ops.slice();
  }

  loadCheckpoint(): unknown { return this.checkpoint; }
  saveCheckpoint(value: unknown): void {
    this.checkpoint = value;
    this.engine.saveCheckpoint(this.instanceKey, this.all(), value);
  }

  /** engine-internal: purge empties the live view too. */
  clear(): void {
    this.ops = [];
    this.checkpoint = undefined;
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
      if (!openReq.result.objectStoreNames.contains(STORE)) {
        openReq.result.createObjectStore(STORE, { keyPath: ["instanceKey", "origin", "seq"] });
      }
      if (!openReq.result.objectStoreNames.contains(CHECKPOINTS)) {
        openReq.result.createObjectStore(CHECKPOINTS, { keyPath: "instanceKey" });
      }
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      openReq.onblocked = () => {
        blocked = true;
        reject(new Error("Draft storage upgrade is blocked by another tab; reload or close that tab, then retry."));
      };
      openReq.onerror = () => reject(openReq.error);
      openReq.onsuccess = () => {
        if (blocked) { openReq.result.close(); return; }
        resolve(openReq.result);
      };
    });
    db.onversionchange = () => db.close();
    const rows = await req<OpRow[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<OpRow[]>);
    // group per instance, straight into each live view — no re-writes of what
    // was just read (rows arrive in key order: instance, origin, seq).
    const byInstance = new Map<string, StoredOp[]>();
    for (const row of rows) {
      let ops = byInstance.get(row.instanceKey);
      if (!ops) { byInstance.set(row.instanceKey, (ops = [])); }
      ops.push(row.op);
    }
    const saved = await req<Array<{ instanceKey: string; value: unknown }>>(db.transaction(CHECKPOINTS, "readonly").objectStore(CHECKPOINTS).getAll());
    const checkpoints = new Map(saved.map(row => [row.instanceKey, row.value]));
    const engine = new IndexedDbStoreEngine(db, new Map());
    for (const [key, ops] of byInstance) { engine.cache.set(key, new IdbInstanceStore(engine, key, ops, checkpoints.get(key))); }
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
    if (!cached) { return; }
    const ops = cached.all();
    cached.clear();
    const tx = this.db.transaction([STORE, CHECKPOINTS], "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(CHECKPOINTS).delete(instanceKey);
    for (const op of ops) { tx.objectStore(STORE).delete([instanceKey, op.origin, op.seq]); }
    await done;
  }

  /** Await every in-flight write-through (tests; best-effort before teardown). */
  async flush(): Promise<void> {
    while (this.pending.size) { await Promise.all([...this.pending]); }
  }

  close(): void {
    this.db.close();
  }

  /** State and all operations it names commit in one IndexedDB transaction. */
  saveCheckpoint(instanceKey: string, ops: StoredOp[], value: unknown): void {
    try {
      const tx = this.db.transaction([STORE, CHECKPOINTS], "readwrite");
      const done = transactionDone(tx).catch(() => { /* Previous durable checkpoint remains valid. */ });
      for (const op of ops) { tx.objectStore(STORE).put({ instanceKey, origin: op.origin, seq: op.seq, op }); }
      tx.objectStore(CHECKPOINTS).put({ instanceKey, value });
      this.pending.add(done);
      void done.finally(() => this.pending.delete(done));
    } catch { /* Keep the previous durable checkpoint; the in-memory draft remains. */ }
  }

  /** store-internal write-through: fire-and-forget, tracked for flush(). */
  put(row: OpRow): void {
    try {
      const tx = this.db.transaction(STORE, "readwrite");
      const p = transactionDone(tx).catch(() => {
        // persistence degrades (quota, closed db); memory keeps serving.
      });
      tx.objectStore(STORE).put(row);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    } catch {
      // transaction refused (db closing): same stance.
    }
  }
}
