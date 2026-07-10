// mount -> session (s-stack-connect): a mount whose config carries a glade
// destination attaches the instance to a session so REMOTE ops flow into the
// same per-instance assembly. Tested two ways (dev-docs/DecisionLog.md GAP-4):
//  (1) a FAKE destination — proves the instance's glade wiring in isolation;
//  (2) a REAL in-process `@glade/client-ts` Session pair converging through a
//      local op bus — the real fold/store/chain code, no glade-node spawned.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BindingDecl } from "@owebeeone/glade-decl";
import { GlialBinder } from "../src/binder.ts";
import type { Fill, GladeDestination } from "../src/instance.ts";
import { MemoryStoreEngine, type StoredOp } from "../src/store.ts";
import { feedSession, SessionDestination, type OpBus, type SessionLike, type WireOp } from "../src/session.ts";
import type { InstanceEvent } from "../src/events.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

import { loadSchema } from "../../glade/client-ts/src/taut/schema.ts";
import { Session } from "../../glade/client-ts/src/session.ts";

function decl(id: string, shape: "value" | "log"): BindingDecl {
  return {
    glade_id: { id },
    shape,
    authority: "share",
    source: null,
    domain: "document",
    zone: "commons",
    retention: { policy: "from_cursor", ttl_ms: null },
  };
}
const DOC1: Fill = { domain: "doc-1" };

// ---- (1) fake destination -------------------------------------------------

class FakeDestination implements GladeDestination {
  sent: Uint8Array[] = [];
  private handler?: (ops: StoredOp[]) => void;
  private seq = 0;
  send(payload: Uint8Array): StoredOp {
    this.sent.push(payload);
    return { origin: "local", seq: ++this.seq, lamport: this.seq, prev: null, payload };
  }
  subscribe(onOps: (ops: StoredOp[]) => void): () => void {
    this.handler = onOps;
    return () => (this.handler = undefined);
  }
  /** test hook: deliver remote ops as if they came off the wire. */
  deliver(ops: StoredOp[]): void {
    this.handler?.(ops);
  }
}

describe("mount -> session — fake destination", () => {
  it("ships local writes and folds remote ops into the same assembly", () => {
    const b = new GlialBinder();
    const d = decl("notes.body", "log");
    const fake = new FakeDestination();
    const events: InstanceEvent[] = [];
    const m = b.mount(d, DOC1, (e) => events.push(e), { glade: fake });
    expect(m.instance.connected).toBe(true);

    m.instance.write(utf8("- local line"));
    expect(fake.sent.map(fromUtf8)).toEqual(["- local line"]); // shipped to the wire

    // a remote op arrives (higher lamport => later position) and folds in.
    fake.deliver([{ origin: "remote", seq: 1, lamport: 5, prev: null, payload: utf8("- remote line") }]);
    const last = events[events.length - 1];
    expect(last.records!.map((r) => fromUtf8(r.payload))).toEqual(["- local line", "- remote line"]);
  });
});

// ---- (2) real in-process client-ts sessions -------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const schema = loadSchema(
  JSON.parse(readFileSync(join(here, "..", "..", "taut", "corpus", "glade.ir.json"), "utf8")),
);

/** An in-process op bus modelling the node fan-out: publish reaches every
 *  attached destination; each filters to its own route (echo-guarded). */
class LocalMesh implements OpBus {
  private handlers = new Set<(ops: WireOp[]) => void>();
  publish(ops: WireOp[]): void {
    for (const h of [...this.handlers]) h(ops);
  }
  onOps(handler: (ops: WireOp[]) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

describe("mount -> session — real @glade/client-ts sessions converge", () => {
  it("two glial binders on one mesh converge a value binding through glial assembly", () => {
    const mesh = new LocalMesh();
    const d = decl("notes.title", "value");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "value", key: new Uint8Array() };

    const sessA = new Session(schema, "a") as unknown as SessionLike;
    const sessB = new Session(schema, "b") as unknown as SessionLike;
    const binderA = new GlialBinder();
    const binderB = new GlialBinder();

    let aVal: InstanceEvent | undefined;
    let bVal: InstanceEvent | undefined;
    const mA = binderA.mount(d, DOC1, (e) => (aVal = e), { glade: new SessionDestination(sessA, mesh, route) });
    const mB = binderB.mount(d, DOC1, (e) => (bVal = e), { glade: new SessionDestination(sessB, mesh, route) });

    // A writes; B assembles A's op (remote-in) inside glial.
    mA.instance.write(utf8("from-a"));
    expect(fromUtf8(bVal!.value!)).toBe("from-a");

    // B writes back; higher lamport wins lww; A converges to it.
    mB.instance.write(utf8("from-b"));
    expect(fromUtf8(aVal!.value!)).toBe("from-b");
    expect(fromUtf8(bVal!.value!)).toBe("from-b");
  });

  it("reload-resume (GAP-9): own-origin replay reaches the session, not the fold; the next write continues the chain", () => {
    const d = decl("notes.title", "value");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "value", key: new Uint8Array() };

    // page life 1: origin "x" writes through a connected instance, tab goes away.
    const mesh1 = new LocalMesh();
    const sess1 = new Session(schema, "x") as unknown as SessionLike;
    const binder1 = new GlialBinder(undefined, "x");
    const m1 = binder1.mount(d, DOC1, undefined, { glade: new SessionDestination(sess1, mesh1, route) });
    const first = m1.instance.write(utf8("first")) as WireOp;

    // page life 2: SAME origin, fresh session/binder — the reload (store empty).
    const mesh2 = new LocalMesh();
    const sess2 = new Session(schema, "x") as unknown as SessionLike;
    const binder2 = new GlialBinder(undefined, "x");
    const events: InstanceEvent[] = [];
    const m2 = binder2.mount(d, DOC1, (e) => events.push(e), { glade: new SessionDestination(sess2, mesh2, route) });
    const eventsBeforeReplay = events.length;

    // the node replay delivers the participant's OWN prior op off the bus.
    mesh2.publish([first]);

    // the echo guard still holds for assembly: own-origin replay does not re-fold...
    expect(events.length).toBe(eventsBeforeReplay);

    // ...but the session absorbed it: the next write continues the chain (seq 1,
    // not a forked seq 0 the node would drop)...
    const published: WireOp[] = [];
    mesh2.onOps((ops) => published.push(...ops));
    m2.instance.write(utf8("second"));
    expect(published[0]!.seq).toBe(1);

    // ...with prev-hash + lamport resumed: a witness accepts the pair and lww
    // resolves to the post-reload value (a fork/gap would leave "first").
    const witness = new Session(schema, "w");
    witness.applyRemote([first, published[0]!] as never);
    expect(fromUtf8(witness.fold("app", d.glade_id.id, "value") as Uint8Array)).toBe("second");
  });

  it("reload-resume (GAP-9): attachGlade hydrates the session from persisted ops — offline-from-boot does not fork", () => {
    const d = decl("notes.title", "value");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "value", key: new Uint8Array() };
    const engine = new MemoryStoreEngine(); // shared across lives: stands in for the persistent GC-4 engine

    // page life 1: a connected write persists the FULL wire op in the store.
    const mesh1 = new LocalMesh();
    const sess1 = new Session(schema, "x") as unknown as SessionLike;
    const binder1 = new GlialBinder(engine, "x");
    const m1 = binder1.mount(d, DOC1, undefined, { glade: new SessionDestination(sess1, mesh1, route) });
    const first = m1.instance.write(utf8("first")) as WireOp;

    // page life 2: same origin + same (persistent) engine, fresh session, and
    // NO node replay — the tab boots offline.
    const mesh2 = new LocalMesh();
    const sess2 = new Session(schema, "x") as unknown as SessionLike;
    const binder2 = new GlialBinder(engine, "x");
    let val: InstanceEvent | undefined;
    const m2 = binder2.mount(d, DOC1, (e) => (val = e), { glade: new SessionDestination(sess2, mesh2, route) });

    // rule-1 persistence: own prior state is visible from the local store alone.
    expect(fromUtf8(val!.value!)).toBe("first");

    // the destination hydrated the session at attach, so an offline write
    // CONTINUES the chain instead of forking at seq 0...
    const published: WireOp[] = [];
    mesh2.onOps((ops) => published.push(...ops));
    m2.instance.write(utf8("second"));
    expect(published[0]!.seq).toBe(1);

    // ...and the pair chains cleanly for any witness (prev hash + lamport).
    const witness = new Session(schema, "w");
    witness.applyRemote([first, published[0]!] as never);
    expect(fromUtf8(witness.fold("app", d.glade_id.id, "value") as Uint8Array)).toBe("second");
  });

  it("GAP-9 backfill: a late mount catches up from the session — replay absorbed before any mount is not lost", () => {
    const d = decl("notes.body", "log");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "log", key: new Uint8Array() };

    // prior lives on one mesh: y and x each append one record.
    const seed = new LocalMesh();
    const sessY = new Session(schema, "y") as unknown as SessionLike;
    const sessX1 = new Session(schema, "x") as unknown as SessionLike;
    const mY = new GlialBinder(undefined, "y").mount(d, DOC1, undefined, { glade: new SessionDestination(sessY, seed, route) });
    const mX1 = new GlialBinder(undefined, "x").mount(d, DOC1, undefined, { glade: new SessionDestination(sessX1, seed, route) });
    const yOp = mY.instance.write(utf8("- y1")) as WireOp;
    const xOp = mX1.instance.write(utf8("- x1")) as WireOp;

    // x reloads: the carrier feeds the fresh session BEFORE any mount exists
    // (feedSession is the bus->session absorber the demo hand-rolled)...
    const mesh = new LocalMesh();
    const sessX2 = new Session(schema, "x") as unknown as SessionLike;
    feedSession(sessX2, mesh);
    mesh.publish([yOp, xOp]); // the node replay: no route is mounted yet

    // ...and the LATE mount backfills its fold from the session store —
    // own-origin history included (this is catch-up, not a live echo).
    const events: InstanceEvent[] = [];
    const mX2 = new GlialBinder(undefined, "x").mount(d, DOC1, (e) => events.push(e), {
      glade: new SessionDestination(sessX2, mesh, route),
    });
    expect(events[0]!.records!.map((r) => fromUtf8(r.payload))).toEqual(["- y1", "- x1"]);

    // the resumed chain still appends cleanly on top of the backfill.
    const published: WireOp[] = [];
    mesh.onOps((ops) => published.push(...ops));
    mX2.instance.write(utf8("- x2"));
    expect(published[0]!.seq).toBe(1);
    const last = events[events.length - 1]!;
    expect(last.records!.map((r) => fromUtf8(r.payload))).toEqual(["- y1", "- x1", "- x2"]);
  });

  it("remote log ops arrive as deltas into a live instance", () => {
    const mesh = new LocalMesh();
    const d = decl("notes.body", "log");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "log", key: new Uint8Array() };

    const sessA = new Session(schema, "a") as unknown as SessionLike;
    const sessB = new Session(schema, "b") as unknown as SessionLike;
    const binderA = new GlialBinder();
    const binderB = new GlialBinder();

    const bEvents: InstanceEvent[] = [];
    const mA = binderA.mount(d, DOC1, undefined, { glade: new SessionDestination(sessA, mesh, route) });
    binderB.mount(d, DOC1, (e) => bEvents.push(e), { glade: new SessionDestination(sessB, mesh, route) });

    mA.instance.write(utf8("- a1"));
    mA.instance.write(utf8("- a2"));

    const deltas = bEvents.filter((e) => e.envelope.kind === "delta");
    expect(deltas.flatMap((e) => e.delta!.map((r) => fromUtf8(r.payload)))).toEqual(["- a1", "- a2"]);
  });
});
