// The GC-4 persistent store engine (dev-docs/DecisionLog.md GAP-10): IndexedDB
// behind the SAME sync `StoreEngine` seam — an async factory preloads every
// persisted op into a write-through memory cache, so binder/instance code is
// untouched. Ops persist WHOLESALE (wire fields ride along), which is what lets
// `SessionDestination.hydrate` re-validate the prev-hash chain exactly (GAP-9).
// Tested against fake-indexeddb; the factory is injectable, so the same code
// runs on the browser's real `indexedDB`.

import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BindingDecl } from "@owebeeone/glade-decl";
import { GlialBinder } from "../src/binder.ts";
import type { Fill } from "../src/instance.ts";
import { IndexedDbStoreEngine } from "../src/store_idb.ts";
import { SessionDestination, type OpBus, type SessionLike, type WireOp } from "../src/session.ts";
import type { InstanceEvent } from "../src/events.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

import { loadSchema } from "../../glade/client-ts/src/taut/schema.ts";
import { Session } from "../../glade/client-ts/src/session.ts";

const op = (origin: string, seq: number, text: string) => ({
  origin,
  seq,
  lamport: seq + 1,
  prev: null,
  payload: utf8(text),
});

describe("IndexedDbStoreEngine — the GC-4 persistent engine", () => {
  it("persists ops across engine opens (the reload) and dedups re-appends", async () => {
    const idb = new IDBFactory(); // one fake browser profile
    const e1 = await IndexedDbStoreEngine.open("glial-test", idb);
    const s1 = e1.open("inst-a");
    s1.append(op("x", 0, "first"));
    s1.append(op("x", 1, "second"));
    s1.append(op("x", 1, "second")); // re-delivered: not stored twice
    expect(s1.all().length).toBe(2);
    await e1.flush();
    e1.close();

    const e2 = await IndexedDbStoreEngine.open("glial-test", idb);
    const s2 = e2.open("inst-a");
    expect(s2.all().map((o) => fromUtf8(o.payload))).toEqual(["first", "second"]);
    s2.append(op("x", 0, "first")); // dedup survives the reload too
    expect(s2.all().length).toBe(2);
    e2.close();
  });

  it("keeps instances separate and persists records wholesale (wire fields survive)", async () => {
    const idb = new IDBFactory();
    const e1 = await IndexedDbStoreEngine.open("glial-test", idb);
    const wireOp = {
      ...op("x", 0, "hello"),
      share: "app",
      glade_id: "notes.title",
      key: new Uint8Array([1, 2]),
      refs: [],
      shape: "value",
    };
    e1.open("inst-a").append(wireOp);
    e1.open("inst-b").append(op("y", 0, "other"));
    await e1.flush();
    e1.close();

    const e2 = await IndexedDbStoreEngine.open("glial-test", idb);
    expect(e2.open("inst-b").all().length).toBe(1);
    const restored = e2.open("inst-a").all()[0] as WireOp;
    expect(restored.share).toBe("app");
    expect(restored.glade_id).toBe("notes.title");
    expect([...restored.key]).toEqual([1, 2]);
    expect(restored.payload).toBeInstanceOf(Uint8Array);
    expect(fromUtf8(restored.payload)).toBe("hello");
    e2.close();
  });

  it("drop() RETAINS persisted ops — teardown is not eviction (GAP-10)", async () => {
    const idb = new IDBFactory();
    const e1 = await IndexedDbStoreEngine.open("glial-test", idb);
    e1.open("inst-a").append(op("x", 0, "kept"));
    await e1.flush();
    e1.drop("inst-a"); // last unmount: the instance goes away, the history does not
    expect(e1.open("inst-a").all().length).toBe(1); // same engine re-open
    e1.close();

    const e2 = await IndexedDbStoreEngine.open("glial-test", idb);
    expect(fromUtf8(e2.open("inst-a").all()[0]!.payload)).toBe("kept");
    e2.close();
  });

  it("purge() actually deletes an instance's persisted ops", async () => {
    const idb = new IDBFactory();
    const e1 = await IndexedDbStoreEngine.open("glial-test", idb);
    e1.open("inst-a").append(op("x", 0, "gone"));
    await e1.flush();
    await e1.purge("inst-a");
    expect(e1.open("inst-a").all().length).toBe(0);
    e1.close();

    const e2 = await IndexedDbStoreEngine.open("glial-test", idb);
    expect(e2.open("inst-a").all().length).toBe(0);
    e2.close();
  });
});

// ---- the whole reload-resume story, end to end through the real engine -----

const here = dirname(fileURLToPath(import.meta.url));
const schema = loadSchema(
  JSON.parse(readFileSync(join(here, "..", "..", "taut", "corpus", "glade.ir.json"), "utf8")),
);

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

describe("reload-resume through the persistent engine (GAP-9 + GAP-10)", () => {
  it("a reloaded offline tab shows its own state AND continues its chain", async () => {
    const idb = new IDBFactory();
    const d = decl("notes.title", "value");
    const route = { share: "app", gladeId: d.glade_id.id, shape: "value", key: new Uint8Array() };

    // page life 1: connected write, then the tab goes away (unmount included —
    // drop retains, so teardown must not cost the user their history).
    const engine1 = await IndexedDbStoreEngine.open("glial", idb);
    const sess1 = new Session(schema, "x") as unknown as SessionLike;
    const binder1 = new GlialBinder(engine1, "x");
    const m1 = binder1.mount(d, DOC1, undefined, { glade: new SessionDestination(sess1, new LocalMesh(), route) });
    const first = m1.instance.write(utf8("first")) as WireOp;
    m1.unmount();
    await engine1.flush();
    engine1.close();

    // page life 2: fresh everything except the origin and the IndexedDB —
    // and NO node replay (the tab boots offline).
    const engine2 = await IndexedDbStoreEngine.open("glial", idb);
    const sess2 = new Session(schema, "x") as unknown as SessionLike;
    const binder2 = new GlialBinder(engine2, "x");
    const mesh2 = new LocalMesh();
    let val: InstanceEvent | undefined;
    const m2 = binder2.mount(d, DOC1, (e) => (val = e), { glade: new SessionDestination(sess2, mesh2, route) });

    // own prior state is visible from IndexedDB alone (rule 1)...
    expect(fromUtf8(val!.value!)).toBe("first");

    // ...and the offline write continues the persisted chain (no fork).
    const published: WireOp[] = [];
    mesh2.onOps((ops) => published.push(...ops));
    m2.instance.write(utf8("second"));
    expect(published[0]!.seq).toBe(1);

    const witness = new Session(schema, "w");
    witness.applyRemote([first, published[0]!] as never);
    expect(fromUtf8(witness.fold("app", d.glade_id.id, "value") as Uint8Array)).toBe("second");
    engine2.close();
  });
});
