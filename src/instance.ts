// A binding INSTANCE (GlialClientRuntime §Boundaries, 2026-07-10): (decl, fill)
// with its own store destination, its own fold/assembly state, and a refcounted
// lifecycle. Several instances of one app-static decl live at once — each here
// is fully independent. Assembly runs INSIDE the instance (rule 2); the instance
// fans a rich change event to every attached consumer (rule 3).

import type { BindingDecl } from "@owebeeone/glade-decl";
import type { InstanceStore, StoredOp } from "./store.ts";
import { ValueRegister } from "./folds/value.ts";
import { LogBuffer, type LogRecord } from "./folds/log.ts";
import { type InstanceEvent, logDelta, logRefresh, valueRefresh } from "./events.ts";

/** The concrete fill that turns an app-static decl into a live instance. The
 *  decl's `domain` is an ANCHOR (account|document|deployment); the fill is the
 *  concrete id for it, plus an optional zone/key (dev-docs/DecisionLog.md
 *  GAP-2). glial never sees how grip chose the fill — the seam is fill-only. */
export interface Fill {
  domain: string;
  zone?: string;
  key?: string;
}

export function instanceKey(gladeId: string, fill: Fill): string {
  return `${gladeId}\x00${fill.domain}\x00${fill.zone ?? ""}\x00${fill.key ?? ""}`;
}

/** An op's stable identity — the (origin, seq) pair the store and every fold
 *  dedup on (client-ts foldLog). The log delta stream is diffed by this identity,
 *  immune to the whole's re-sorting on late low-lamport arrival (SR56-2-21). */
function opId(o: StoredOp): string {
  return `${o.origin}\x00${o.seq}`;
}

/** The configured connectivity destination (set only when a mount mounts it,
 *  B2/GDL-035). The wire and session live below this seam; glial owns what
 *  reaches consumers. Injectable so the instance tests without a live node. */
export interface GladeDestination {
  /** Ship a local payload to the mesh; returns the authoritative op meta. */
  send(payload: Uint8Array): StoredOp;
  /** Subscribe to inbound remote ops; returns an unsubscribe. */
  subscribe(onOps: (ops: StoredOp[]) => void): () => void;
  /** Optional two-way hydration at attach (GAP-9): absorb the instance's
   *  persisted ops (a fresh session resumes its own chain even with no node
   *  replay), and return any ops the destination already knows for this route
   *  that the instance lacks — the backfill a late mount folds to catch up. */
  hydrate?(ops: StoredOp[]): StoredOp[] | void;
}

type Listener = (e: InstanceEvent) => void;

export class BindingInstance {
  readonly key: string;
  readonly decl: BindingDecl;
  readonly fill: Fill;
  refcount = 0;

  private readonly gladeId: string;
  private readonly isLog: boolean;
  private readonly store: InstanceStore;
  private readonly localOrigin: string;
  private readonly listeners = new Set<Listener>();

  // log: op-identities already delivered as deltas. Identity, NOT a positional
  // cursor into the whole — the whole is re-sorted (lamport,origin,seq) every
  // fold, so a late low-lamport op inserts mid-list; an index would dup/drop
  // (SR56-2-21). Monotonic: the op-set only grows, so this set only grows.
  private readonly emitted = new Set<string>();
  private glade?: GladeDestination;
  private gladeOff?: () => void;

  constructor(decl: BindingDecl, fill: Fill, key: string, store: InstanceStore, localOrigin = "local") {
    this.decl = decl;
    this.fill = fill;
    this.key = key;
    this.gladeId = decl.glade_id.id;
    this.isLog = decl.shape === "log";
    this.store = store;
    this.localOrigin = localOrigin;
  }

  /** Whether a glade destination is attached (connectivity configured). */
  get connected(): boolean {
    return this.glade !== undefined;
  }

  /** Attach connectivity: local writes also ship, remote ops flow into assembly
   *  (mount lights connectivity — s-stack-connect). Idempotent-safe: one dest. */
  attachGlade(dest: GladeDestination): void {
    if (this.glade) return;
    this.glade = dest;
    const backfill = dest.hydrate?.(this.store.all()); // persisted chain reaches the session first
    this.gladeOff = dest.subscribe((ops) => this.ingest(ops));
    if (backfill?.length) this.ingest(backfill); // late mount catches up on absorbed replay
  }

  /** A consumer attaches: bump the refcount and hand it a refresh of the live
   *  assembly (no recompute — the fold is fanned). Returns an unsubscribe that
   *  the binder pairs with unmount. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.refreshEvent());
    return () => this.listeners.delete(listener);
  }

  /** A local write through the tap. Mints an op (or defers to the session when
   *  connected), persists it, folds, and fans the change. A synchronous wire
   *  echo may have landed the op via ingest() already — the semantic guard
   *  (append outcome) keeps it to one fold/fan per write either way. */
  write(payload: Uint8Array): StoredOp {
    const op = this.glade ? this.glade.send(payload) : this.mintLocal(payload);
    if (this.store.append(op) === "appended") this.foldAndBroadcast();
    return op;
  }

  /** Ops arriving from the session — persist, fold, fan (assembly inside
   *  glial: the session is a destination adapter, not where ops become
   *  meaning). Own-origin ops are welcome: a duplicate (wire echo, re-replay)
   *  dedups to a no-op; genuine catch-up folds like anyone's ops (GAP-9). */
  ingest(ops: StoredOp[]): void {
    let landed = false;
    for (const op of ops) if (this.store.append(op) === "appended") landed = true;
    if (landed) this.foldAndBroadcast();
  }

  /** Boot/hydrate: mark every persisted op delivered so the first post-mount
   *  fold emits only genuinely new records — the mount itself refreshes the whole
   *  (subscribe -> refreshEvent). Value shape keeps no delta cursor. */
  hydrate(): void {
    if (this.isLog) for (const o of this.store.all()) this.emitted.add(opId(o));
  }

  dispose(): void {
    this.gladeOff?.();
    this.listeners.clear();
  }

  // ---- assembly -----------------------------------------------------------

  private mintLocal(payload: Uint8Array): StoredOp {
    const ops = this.store.all();
    const seq = ops.filter((o) => o.origin === this.localOrigin).length + 1;
    const lamport = ops.reduce((m, o) => Math.max(m, o.lamport), 0) + 1;
    return { origin: this.localOrigin, seq, lamport, prev: null, payload };
  }

  /** The op-set in the convergent total order (lamport, origin, seq) — the order
   *  every replica's fold produces (client-ts foldLog / the cross-language fold
   *  oracle). Re-sortable by design: a late low-lamport op inserts mid-list. */
  private sortedOps(): StoredOp[] {
    return this.store.all().sort(
      (a, b) => a.lamport - b.lamport || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.seq - b.seq,
    );
  }

  private assembleLog(ops: StoredOp[] = this.sortedOps()): LogRecord[] {
    const buf = new LogBuffer();
    for (const o of ops) buf.push(o.payload);
    return buf.all();
  }

  private assembleValue() {
    const reg = new ValueRegister();
    for (const o of this.store.all()) reg.set(o);
    return reg.read();
  }

  private refreshEvent(): InstanceEvent {
    if (this.isLog) return logRefresh(this.decl.glade_id, this.assembleLog());
    const s = this.assembleValue();
    return s.state === "empty"
      ? valueRefresh(this.decl.glade_id, null, null, null)
      : valueRefresh(this.decl.glade_id, s.winner.origin, s.winner.seq, s.value);
  }

  private foldAndBroadcast(): void {
    if (this.isLog) {
      const ops = this.sortedOps();
      const whole = this.assembleLog(ops);
      // Delta by IDENTITY, not a positional slice (SR56-2-21): emit each op
      // exactly once, ever. whole[i] pairs with ops[i], so a delta record keeps
      // its index in the converged whole as .seq. base_seq = records already
      // delivered (= whole.length - delta.length); under reorder that is a count,
      // not an append-position — placement rides on the record's own seq + whole.
      const baseSeq = this.emitted.size;
      const delta: LogRecord[] = [];
      for (let i = 0; i < ops.length; i++) {
        const id = opId(ops[i]);
        if (this.emitted.has(id)) continue;
        this.emitted.add(id);
        delta.push(whole[i]);
      }
      if (delta.length === 0) return;
      const e = logDelta(this.decl.glade_id, baseSeq, delta, whole);
      for (const l of this.listeners) l(e);
    } else {
      const e = this.refreshEvent();
      for (const l of this.listeners) l(e);
    }
  }
}
