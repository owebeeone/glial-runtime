// The glial grip-side ADAPTER (Lane T step 3a). Drives a REAL grip-core Grok with
// the adapter tap registered and reads values back through grip's own query API
// (useGrip-equivalent) — no mocks, against glial's in-memory store path. Proves:
//  (a) a consumer projects a value surface, and a grip-side write round-trips as
//      an instance op through the binder;
//  (b) two matching contexts with two fills => two independent instances, visible
//      end-to-end through grip (the factory form as a per-context matcher row);
//  (c) tap detach releases the instance refcount => teardown;
//  (d) a remote op via a fake SessionLike folds into the SAME assembly and reaches
//      the grip.

import { describe, expect, it } from "vitest";
import type { BindingDecl } from "@owebeeone/glade-decl";
import { Grok } from "@owebeeone/grip-core";
import { GripRegistry, GripOf } from "@owebeeone/grip-core";
import { createAtomValueTap } from "@owebeeone/grip-core";

import { GlialBinder } from "../src/binder.ts";
import type { Fill } from "../src/instance.ts";
import { SessionDestination, type OpBus, type SessionLike, type WireOp } from "../src/session.ts";
import { utf8 } from "../src/bytes.ts";
import {
  glialTap,
  glialTapFactory,
  type GlialTapController,
} from "../src/grip/index.ts";

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

// ---- (a) value surface: consumer projection + grip-side write round-trip ----

describe("GlialTap — value surface through grip", () => {
  it("a consumer projects the value; a grip-side set() writes an instance op", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const TITLE = defineGrip<string>("Title", "");
    const TITLE_CTRL = defineGrip<GlialTapController<string>>("TitleCtrl", undefined as any);

    const grok = new Grok(registry);
    const binder = new GlialBinder();
    const d = decl("notes.title", "value");

    const tap = glialTap({
      binder,
      decl: d,
      grip: TITLE,
      fill: { domain: "doc-1" },
      handleGrip: TITLE_CTRL,
    });

    const home = grok.mainPresentationContext;
    grok.registerTapAt(home, tap as unknown as any);
    const dest = home.createChild();

    const drip = grok.query(TITLE, dest);
    grok.flush();
    // empty instance => the grip default, projected purely (no share vocabulary).
    expect(drip.get()).toBe("");
    expect(binder.isLive(d, { domain: "doc-1" })).toBe(true);

    // write through the controller grip -> instance op -> folded -> back to grip.
    const ctrl = grok.query(TITLE_CTRL, dest).get() as GlialTapController<string>;
    ctrl.set("hello");
    grok.flush();
    expect(drip.get()).toBe("hello");
    expect(ctrl.get()).toBe("hello");
  });

  it("a log surface projects the record list; append() adds one op each", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const LINES = defineGrip<string[]>("Lines", []);
    const LINES_CTRL = defineGrip<GlialTapController<string[]>>("LinesCtrl", undefined as any);

    const grok = new Grok(registry);
    const binder = new GlialBinder();
    const d = decl("notes.body", "log");

    const tap = glialTap({
      binder,
      decl: d,
      grip: LINES,
      fill: { domain: "doc-1" },
      handleGrip: LINES_CTRL,
    });

    const home = grok.mainPresentationContext;
    grok.registerTapAt(home, tap as unknown as any);
    const dest = home.createChild();
    const drip = grok.query(LINES, dest);
    grok.flush();
    expect(drip.get()).toEqual([]);

    const ctrl = grok.query(LINES_CTRL, dest).get() as GlialTapController<string[]>;
    ctrl.append("first");
    ctrl.append("second");
    grok.flush();
    expect(drip.get()).toEqual(["first", "second"]);
  });
});

// ---- (b) two contexts / two fills => two instances (factory matcher row) -----

describe("GlialTapFactory — multi-instance visible through grip", () => {
  it("two matching contexts with distinct key fills => two independent instances", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PRODUCT = defineGrip<string>("Product", "");
    const PRICE = defineGrip<number>("Price", 0);
    const PRICE_CTRL = defineGrip<GlialTapController<number>>("PriceCtrl", undefined as any);

    const grok = new Grok(registry);
    const binder = new GlialBinder();
    const d = decl("coin.price", "value");

    // The fill's key comes from a param grip — declarative, config-as-data. The
    // grip side (a matcher row per column) supplies the param; glial only sees
    // the resulting fill.
    const factory = glialTapFactory({
      binder,
      decl: d,
      grip: PRICE,
      fill: { domain: "market", key: { param: PRODUCT } },
      handleGrip: PRICE_CTRL,
    });

    const parent = grok.mainPresentationContext;
    const mA = parent.getOrCreateMatchingContext("coin:A");
    const mB = parent.getOrCreateMatchingContext("coin:B");
    mA.getGripHomeContext().registerTap(createAtomValueTap(PRODUCT, { initial: "BTC-USD" }));
    mB.getGripHomeContext().registerTap(createAtomValueTap(PRODUCT, { initial: "ETH-USD" }));
    grok.registerTapAt(mA.getGripHomeContext(), factory as unknown as any);
    grok.registerTapAt(mB.getGripHomeContext(), factory as unknown as any);

    const dripA = grok.query(PRICE, mA.getGripConsumerContext());
    const dripB = grok.query(PRICE, mB.getGripConsumerContext());
    grok.flush();

    // one decl, two fills => two live instances.
    expect(binder.instanceCount).toBe(2);
    expect(binder.isLive(d, { domain: "market", key: "BTC-USD" } as Fill)).toBe(true);
    expect(binder.isLive(d, { domain: "market", key: "ETH-USD" } as Fill)).toBe(true);

    // independent assembly state, end-to-end through grip.
    const ctrlA = grok.query(PRICE_CTRL, mA.getGripConsumerContext()).get() as GlialTapController<number>;
    const ctrlB = grok.query(PRICE_CTRL, mB.getGripConsumerContext()).get() as GlialTapController<number>;
    ctrlA.set(42);
    ctrlB.set(99);
    grok.flush();
    expect(dripA.get()).toBe(42);
    expect(dripB.get()).toBe(99);
  });
});

// ---- (c) tap detach => refcount release => instance teardown ----------------

describe("GlialTap — attach/detach rides the instance refcount", () => {
  it("registering mounts (refcount 1); unregistering unmounts (teardown)", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const VALUE = defineGrip<string>("V", "");

    const grok = new Grok(registry);
    const binder = new GlialBinder();
    const d = decl("doc.value", "value");
    const fill: Fill = { domain: "doc-1" };

    const tap = glialTap({ binder, decl: d, grip: VALUE, fill: { domain: "doc-1" } });
    const home = grok.mainPresentationContext;
    grok.registerTapAt(home, tap as unknown as any);
    grok.query(VALUE, home.createChild());
    grok.flush();

    expect(binder.refcountOf(d, fill)).toBe(1);
    expect(binder.isLive(d, fill)).toBe(true);

    grok.unregisterTap(tap as unknown as any); // detach -> unmount
    expect(binder.isLive(d, fill)).toBe(false);
    expect(binder.instanceCount).toBe(0);
  });
});

// ---- (d) remote op via a fake SessionLike -> grip update --------------------

/** An in-process op bus (models the node fan-out). */
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

/** A fake session: only the structural shape glial's SessionDestination needs. */
class FakeSession implements SessionLike {
  readonly origin = "local";
  private seq = 0;
  append(share: string, gladeId: string, _shape: string, payload: Uint8Array, key: Uint8Array = new Uint8Array()): WireOp {
    this.seq += 1;
    return { origin: this.origin, seq: this.seq, lamport: this.seq, prev: null, payload, share, glade_id: gladeId, key };
  }
  applyRemote(_ops: WireOp[]): void {}
}

describe("GlialTap — remote op via a fake SessionLike reaches the grip", () => {
  it("a remote op folds into the same assembly and updates the projected grip", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const BODY = defineGrip<string>("Body", "");

    const grok = new Grok(registry);
    const binder = new GlialBinder();
    const d = decl("notes.title", "value");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "value", key: new Uint8Array() };
    const bus = new LocalMesh();
    const session = new FakeSession();

    const tap = glialTap({
      binder,
      decl: d,
      grip: BODY,
      fill: { domain: "doc-1" },
      // connectivity is config-as-data: fill -> a session-backed destination.
      gladeFor: () => new SessionDestination(session, bus, route),
    });

    const home = grok.mainPresentationContext;
    grok.registerTapAt(home, tap as unknown as any);
    const drip = grok.query(BODY, home.createChild());
    grok.flush();
    expect(drip.get()).toBe("");

    // a remote op arrives off the bus (different origin -> passes the echo guard).
    const remote: WireOp = {
      origin: "remote",
      seq: 1,
      lamport: 5,
      prev: null,
      payload: utf8(JSON.stringify("from-remote")),
      share: "app",
      glade_id: d.glade_id.id,
      key: new Uint8Array(),
    };
    bus.publish([remote]);
    grok.flush();

    expect(drip.get()).toBe("from-remote");
  });
});
