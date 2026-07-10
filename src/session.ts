// mount -> session (s-stack-connect): when a mount's config carries a glade
// destination, an instance attaches to a glade session so remote ops flow into
// the SAME per-instance assembly (glial owns what reaches consumers; the session
// is a destination adapter, not where ops become meaning — GlialClientRuntime).
//
// glial depends on the SHAPE of a session, never a concrete class, so the
// transport is injectable (dev-docs/DecisionLog.md GAP-4): a real
// `@glade/client-ts` Session, the WS-carried GladeClient, or a fake all satisfy
// `SessionLike` + `OpBus`. This is also why grip-share's DIRECT glade coupling
// can be deleted (GDL-035): glial holds the only session reference.

import type { GladeDestination } from "./instance.ts";
import type { StoredOp } from "./store.ts";
import { bytesEq } from "./bytes.ts";

/** An op as it rides the wire — a StoredOp plus its glade routing address. */
export interface WireOp extends StoredOp {
  share: string;
  glade_id: string;
  key: Uint8Array;
}

/** The structural view of a glade session glial needs: mint an authoritative
 *  local op, and absorb remote ops (for resume/heads). Assembly is glial's, so
 *  the session's own fold is deliberately NOT used here. */
export interface SessionLike {
  readonly origin: string;
  append(share: string, gladeId: string, shape: string, payload: Uint8Array, key?: Uint8Array): WireOp;
  applyRemote(ops: WireOp[]): void;
  /** Optional read-back of every op the session has absorbed — what lets a
   *  late mount BACKFILL its instance from session knowledge (GAP-9). */
  dump?(): WireOp[];
}

/** The carrier absorber (GAP-9): feed EVERY inbound bus op to the session,
 *  route-agnostically — heads/resume vectors stay truthful and chains resume
 *  for routes that are not (yet) mounted, so mount order stops mattering.
 *  Route-scoped destinations then backfill their instance at attach. Returns
 *  the unsubscribe. */
export function feedSession(session: SessionLike, bus: OpBus): () => void {
  return bus.onOps((ops) => session.applyRemote(ops));
}

/** The fan point ops leave/enter through — the WS carrier in production, an
 *  in-process hub in tests. glial only needs publish + subscribe. */
export interface OpBus {
  publish(ops: WireOp[]): void;
  onOps(handler: (ops: WireOp[]) => void): () => void;
}

/** The (share, glade id, shape, key) a bound instance addresses on the wire —
 *  the BindingDecl's glade id + the fill's zone key (GladeZones mapping). */
export interface Route {
  share: string;
  gladeId: string;
  shape: string;
  key: Uint8Array;
}

/** Adapts a glade session + op bus to an instance's `GladeDestination`. */
export class SessionDestination implements GladeDestination {
  constructor(private readonly session: SessionLike, private readonly bus: OpBus, private readonly route: Route) {}

  /** Two-way hydration at attach (GAP-9). Store -> session: replay the
   *  instance's persisted ops so a fresh session with a stable origin resumes
   *  its own chain (seq/prev/lamport) even before — or without — any node
   *  replay (offline-from-boot would otherwise fork); only ops that actually
   *  rode the wire (they carry their glade address) are replayed, per origin
   *  in seq order, as the wholesale stored records so the prev-hash chain
   *  re-validates exactly. Session -> store: RETURNS the session's route ops
   *  the instance does not hold — the backfill a LATE mount folds to catch up
   *  on replay absorbed before it existed (feedSession). The session store
   *  dedups one direction; the instance's (origin, seq) set gates the other. */
  hydrate(ops: StoredOp[]): StoredOp[] {
    const wire = ops.filter(
      (o): o is WireOp =>
        typeof (o as WireOp).share === "string" &&
        typeof (o as WireOp).glade_id === "string" &&
        (o as WireOp).key instanceof Uint8Array,
    );
    wire.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.seq - b.seq));
    if (wire.length) this.session.applyRemote(wire);

    const known = this.session.dump?.();
    if (!known) return [];
    const held = new Set(ops.map((o) => `${o.origin}\x00${o.seq}`));
    return known.filter(
      (o) =>
        o.share === this.route.share &&
        o.glade_id === this.route.gladeId &&
        bytesEq(o.key, this.route.key) &&
        !held.has(`${o.origin}\x00${o.seq}`),
    );
  }

  send(payload: Uint8Array): StoredOp {
    const op = this.session.append(this.route.share, this.route.gladeId, this.route.shape, payload, this.route.key);
    this.bus.publish([op]);
    return op;
  }

  subscribe(onOps: (ops: StoredOp[]) => void): () => void {
    return this.bus.onOps((ops) => {
      const routed = ops.filter(
        (o) =>
          o.share === this.route.share &&
          o.glade_id === this.route.gladeId &&
          bytesEq(o.key, this.route.key),
      );
      if (routed.length === 0) return;
      // The session absorbs EVERY routed op — own-origin included — so a fresh
      // session with a stable origin (a tab reload) resumes its chain seq/prev
      // and lamport off the node replay instead of forking at seq 0 (GAP-9).
      // Live echoes of our own publishes dedup in the session store.
      this.session.applyRemote(routed);
      // The echo guard holds for ASSEMBLY only: own ops fold at write() time,
      // and reload-restore of own state is the store engine's job (GC-4).
      const remote = routed.filter((o) => o.origin !== this.session.origin);
      if (remote.length) onOps(remote);
    });
  }
}
