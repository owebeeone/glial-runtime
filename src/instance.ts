// A binding INSTANCE (GlialClientRuntime §Boundaries, 2026-07-10): (decl, fill)
// with its own store destination, its own fold/assembly state, and a refcounted
// lifecycle. Several instances of one app-static decl live at once — each here
// is fully independent. Assembly runs INSIDE the instance (rule 2); the instance
// fans a rich change event to every attached consumer (rule 3).

import type { BindingDecl } from "@owebeeone/glade-decl";
import type { InstanceStore, StoredOp } from "./store.ts";
import { ValueRegister } from "./folds/value.ts";
import { LogBuffer, type LogRecord } from "./folds/log.ts";
import { type InstanceEvent, logDelta, logRefresh, swmrChange, textCrdtChange, valueRefresh } from "./events.ts";
import { type GlialShapeAdapter, requireMountShapeAdapter } from "./shapes.ts";
import {
  assembleSwmr,
  encodeSwmrAction,
  SwmrAdapterError,
  type GlialSwmrAction,
  type SwmrAssembly,
} from "./swmr.ts";
import {
  assembleTextCrdt,
  decodeTextEdit,
  encodeTextEdit,
  nextTextCounter,
  planTextReplacement,
  textAtomId,
  type TextCrdtState,
} from "./text_crdt.ts";

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
  /** Authenticated origin used by send(); required for pre-send SWMR checks. */
  readonly origin?: string;
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
  private readonly adapter: GlialShapeAdapter;
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

  constructor(
    decl: BindingDecl,
    fill: Fill,
    key: string,
    store: InstanceStore,
    localOrigin = "local",
    private readonly crdtProfile?: "text_crdt",
  ) {
    this.decl = decl;
    this.fill = fill;
    this.key = key;
    this.gladeId = decl.glade_id.id;
    this.adapter = requireMountShapeAdapter(decl.shape, "instance construction");
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
    if (this.adapter.shape === "crdt") decodeTextEdit(payload);
    if (this.adapter.shape === "swmr") {
      if (this.glade && this.glade.origin === undefined) {
        throw new SwmrAdapterError(
          "missing_writer_origin",
          `connected SWMR destination for ${this.gladeId} does not expose its authenticated origin`,
        );
      }
      const origin = this.glade?.origin ?? this.localOrigin;
      this.preflightSwmr([this.previewLocal(payload, origin)]);
    }
    const op = this.glade ? this.glade.send(payload) : this.mintLocal(payload);
    if (this.adapter.shape === "swmr") this.preflightSwmr([op]);
    if (this.adapter.shape === "crdt") assembleTextCrdt([...this.store.all(), op]);
    if (this.store.append(op) === "appended") this.foldAndBroadcast([op]);
    return op;
  }

  /** Exact SWMR write surface: action header + opaque application body. */
  writeSwmr(action: GlialSwmrAction, body: Uint8Array = new Uint8Array()): StoredOp {
    if (this.adapter.shape !== "swmr") {
      throw new Error(`Glial instance ${this.gladeId}: writeSwmr() requires shape swmr`);
    }
    return this.write(encodeSwmrAction(action, body));
  }

  /** Ops arriving from the session — persist, fold, fan (assembly inside
   *  glial: the session is a destination adapter, not where ops become
   *  meaning). Own-origin ops are welcome: a duplicate (wire echo, re-replay)
   *  dedups to a no-op; genuine catch-up folds like anyone's ops (GAP-9). */
  ingest(ops: StoredOp[]): void {
    if (this.adapter.shape === "swmr") this.preflightSwmr(ops);
    if (this.adapter.shape === "crdt") assembleTextCrdt([...this.store.all(), ...ops]);
    let landed = false;
    const delta: StoredOp[] = [];
    for (const op of ops) {
      if (this.store.append(op) !== "appended") continue;
      landed = true;
      delta.push(op);
    }
    if (landed) this.foldAndBroadcast(delta);
  }

  /** Boot/hydrate: mark every persisted op delivered so the first post-mount
   *  fold emits only genuinely new records — the mount itself refreshes the whole
   *  (subscribe -> refreshEvent). Value shape keeps no delta cursor. */
  hydrate(): void {
    if (this.adapter.shape === "log") for (const o of this.store.all()) this.emitted.add(opId(o));
    if (this.adapter.shape === "swmr") this.swmrAssembly();
    if (this.adapter.shape === "crdt") this.textCrdtState();
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
    const refs = this.adapter.shape === "crdt" ? this.crdtHeads(ops) : undefined;
    return { origin: this.localOrigin, seq, lamport, prev: null, refs, payload };
  }

  private previewLocal(payload: Uint8Array, origin: string): StoredOp {
    const ops = this.store.all();
    const seq = ops.filter((o) => o.origin === origin).length + 1;
    const lamport = ops.reduce((m, o) => Math.max(m, o.lamport), 0) + 1;
    const refs = this.adapter.shape === "crdt" ? this.crdtHeads(ops) : undefined;
    return { origin, seq, lamport, prev: null, refs, payload };
  }

  private crdtHeads(ops: StoredOp[]): StoredOp["refs"] {
    const latest = new Map<string, StoredOp>();
    for (const op of ops) {
      const prior = latest.get(op.origin);
      if (!prior || op.seq > prior.seq) latest.set(op.origin, op);
    }
    return [...latest.values()]
      .sort((left, right) => left.origin.localeCompare(right.origin))
      .map((op) => ({ origin: op.origin, seq: op.seq, hash: null }));
  }

  private preflightSwmr(incoming: StoredOp[]): void {
    assembleSwmr([...this.store.all(), ...incoming], this.gladeId);
  }

  /** Current canonical SWMR assembly. Public for typed projections. */
  swmrAssembly(): SwmrAssembly {
    if (this.adapter.shape !== "swmr") {
      throw new Error(`Glial instance ${this.gladeId}: swmrAssembly() requires shape swmr`);
    }
    return assembleSwmr(this.store.all(), this.gladeId);
  }

  /** Current identity-bearing text projection for a text_crdt profile mount. */
  textCrdtState(): TextCrdtState {
    if (this.adapter.shape !== "crdt" || this.crdtProfile !== "text_crdt") {
      throw new Error(`Glial instance ${this.gladeId}: textCrdtState() requires a text_crdt profile`);
    }
    return assembleTextCrdt(this.store.all());
  }

  /** Replace the editor projection by emitting identity insert/delete ops. */
  replaceText(nextText: string): void {
    if (this.adapter.shape !== "crdt" || this.crdtProfile !== "text_crdt") {
      throw new Error(`Glial instance ${this.gladeId}: replaceText() requires a text_crdt profile`);
    }
    const state = this.textCrdtState();
    const actorId = this.glade?.origin ?? this.localOrigin;
    let counter = nextTextCounter(state, actorId);
    let insertionOrder = this.store.all().reduce((order, op) => Math.max(order, op.lamport), 0) + 1;
    const edits = planTextReplacement(
      state,
      nextText,
      () => textAtomId({ actor_id: actorId, counter: counter++ }, insertionOrder++),
    );
    for (const edit of edits) this.write(encodeTextEdit(edit));
  }

  /** Snapshot of durable instance ops, useful for recovery/convergence gates. */
  operations(): StoredOp[] {
    return this.store.all();
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
    if (this.adapter.shape === "log") return logRefresh(this.decl.glade_id, this.assembleLog());
    if (this.adapter.shape === "swmr") return swmrChange(this.decl.glade_id, this.swmrAssembly(), "refresh");
    if (this.adapter.shape === "crdt") return textCrdtChange(this.decl.glade_id, this.textCrdtState(), "refresh");
    const s = this.assembleValue();
    return s.state === "empty"
      ? valueRefresh(this.decl.glade_id, null, null, null)
      : valueRefresh(this.decl.glade_id, s.winner.origin, s.winner.seq, s.value);
  }

  private foldAndBroadcast(landed: readonly StoredOp[] = []): void {
    if (this.adapter.shape === "log") {
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
    } else if (this.adapter.shape === "swmr") {
      const assembly = this.swmrAssembly();
      const e = swmrChange(this.decl.glade_id, assembly, assembly.lastAction === "delta" ? "delta" : "refresh");
      for (const l of this.listeners) l(e);
    } else if (this.adapter.shape === "crdt") {
      const e = textCrdtChange(this.decl.glade_id, this.textCrdtState(), "delta", landed);
      for (const l of this.listeners) l(e);
    } else {
      const e = this.refreshEvent();
      for (const l of this.listeners) l(e);
    }
  }
}
