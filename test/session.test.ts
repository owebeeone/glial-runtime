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
import type { StoredOp } from "../src/store.ts";
import { SessionDestination, type OpBus, type SessionLike, type WireOp } from "../src/session.ts";
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
