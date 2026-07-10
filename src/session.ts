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

  send(payload: Uint8Array): StoredOp {
    const op = this.session.append(this.route.share, this.route.gladeId, this.route.shape, payload, this.route.key);
    this.bus.publish([op]);
    return op;
  }

  subscribe(onOps: (ops: StoredOp[]) => void): () => void {
    return this.bus.onOps((ops) => {
      const mine = ops.filter(
        (o) =>
          o.share === this.route.share &&
          o.glade_id === this.route.gladeId &&
          bytesEq(o.key, this.route.key) &&
          o.origin !== this.session.origin, // echo guard: never re-ingest our own
      );
      if (mine.length === 0) return;
      this.session.applyRemote(mine);
      onOps(mine);
    });
  }
}
