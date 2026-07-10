// A binding INSTANCE (GlialClientRuntime §Boundaries, 2026-07-10): (decl, fill)
// with its own store destination, its own fold/assembly state, and a refcounted
// lifecycle. Several instances of one app-static decl live at once — each here
// is fully independent. Assembly runs INSIDE the instance (rule 2); the instance
// fans a rich change event to every attached consumer (rule 3).

import type { BindingDecl } from "@owebeeone/glade-decl";
import type { InstanceStore, StoredOp } from "./store.ts";
import { ValueRegister } from "./folds/value.ts";
import { LogBuffer } from "./folds/log.ts";
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

  private emittedLen = 0; // log: positions already delivered (delta contiguity)
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
   *  connected), persists it, folds, and fans the change. */
  write(payload: Uint8Array): StoredOp {
    const op = this.glade ? this.glade.send(payload) : this.mintLocal(payload);
    this.store.append(op);
    this.foldAndBroadcast();
    return op;
  }

  /** Remote ops arriving from the session — persist, fold, fan (assembly inside
   *  glial: the session is a destination adapter, not where ops become meaning). */
  ingest(ops: StoredOp[]): void {
    for (const op of ops) this.store.append(op);
    this.foldAndBroadcast();
  }

  /** Boot/hydrate: fold the persisted ops and mark them delivered. */
  hydrate(): void {
    this.emittedLen = this.isLog ? this.assembleLog().length : 0;
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

  private assembleLog() {
    const buf = new LogBuffer();
    const ops = this.store.all().sort(
      (a, b) => a.lamport - b.lamport || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.seq - b.seq,
    );
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
      const whole = this.assembleLog();
      if (whole.length <= this.emittedLen) return;
      const delta = whole.slice(this.emittedLen);
      const e = logDelta(this.decl.glade_id, this.emittedLen, delta, whole);
      this.emittedLen = whole.length;
      for (const l of this.listeners) l(e);
    } else {
      const e = this.refreshEvent();
      for (const l of this.listeners) l(e);
    }
  }
}
