// Declared shape profiles under glade-decl v1, ruling R4(b): a profile is a
// `ShapeProfileDecl{glade_id, profile}` — a record of its own, keyed by glade
// id — and never a `BindingDecl` field. The binder reads it by LOOKUP on the
// mounted decl's glade id, ahead of `MountConfig.crdtProfile`, which stays for
// back-compat. Nothing supplies these records yet (the node persists none), so
// the lookup is an input path a caller hands the binder, not a data source.

import { describe, expect, it } from "vitest";
import type { BindingDecl, Shape, ShapeProfileDecl } from "@owebeeone/glade-decl";

import { GlialBinder, type ShapeProfileLookup } from "../src/binder.ts";
import { MemoryStoreEngine, type InstanceStore, type StoreEngine } from "../src/store.ts";

const FILL = { domain: "doc-1" };

function decl(id: string, shape: Shape): BindingDecl {
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

/** A caller-side lookup over a fixed set of declared records, keyed by id. */
function lookupOf(...records: ShapeProfileDecl[]): ShapeProfileLookup {
  const byId = new Map(records.map((record) => [record.glade_id.id, record]));
  return (gladeId) => byId.get(gladeId);
}

/** Counts store opens: every refusal must happen before any instance state. */
class TrackingStore implements StoreEngine {
  readonly memory = new MemoryStoreEngine();
  opens = 0;

  open(key: string): InstanceStore {
    this.opens += 1;
    return this.memory.open(key);
  }

  drop(key: string): void {
    this.memory.drop(key);
  }
}

describe("declared shape profile (R4(b)) — looked up by glade id, ahead of config.crdtProfile", () => {
  it("mounts a crdt surface from its declared text_crdt profile with no config", () => {
    const lookup = lookupOf({ glade_id: { id: "doc.body" }, profile: "text_crdt" });
    const mount = new GlialBinder(undefined, "alice", lookup).mount(decl("doc.body", "crdt"), FILL);

    // The declared profile reached the instance: the text projection is live.
    mount.instance.replaceText("hello");
    expect(mount.instance.textCrdtState().text).toBe("hello");
  });

  it("a declared profile wins over config.crdtProfile", () => {
    const store = new TrackingStore();
    const lookup = lookupOf({ glade_id: { id: "doc.body" }, profile: "snapshot_delta" });
    const binder = new GlialBinder(store, "alice", lookup);

    // The same config mounts when nothing is declared (next test); here the
    // declaration is read first, and glial mounts crdt only as text_crdt.
    expect(() => binder.mount(decl("doc.body", "crdt"), FILL, undefined, { crdtProfile: "text_crdt" }))
      .toThrow(/declares shape profile "snapshot_delta"/);
    expect(store.opens).toBe(0);
    expect(binder.instanceCount).toBe(0);
  });

  it("the config path still works alone: no lookup, or a lookup with no record for the id", () => {
    const withoutLookup = new GlialBinder(undefined, "alice").mount(
      decl("doc.body", "crdt"), FILL, undefined, { crdtProfile: "text_crdt" },
    );
    expect(withoutLookup.instance.textCrdtState().text).toBe("");

    const elsewhere = lookupOf({ glade_id: { id: "doc.other" }, profile: "snapshot_delta" });
    const withLookup = new GlialBinder(undefined, "alice", elsewhere).mount(
      decl("doc.body", "crdt"), FILL, undefined, { crdtProfile: "text_crdt" },
    );
    expect(withLookup.instance.textCrdtState().text).toBe("");
  });

  it("a crdt mount with neither a declared profile nor config still throws as today", () => {
    const today = 'Glial CRDT mount doc.body requires crdtProfile "text_crdt"';

    const bare = new TrackingStore();
    expect(() => new GlialBinder(bare).mount(decl("doc.body", "crdt"), FILL)).toThrow(today);
    expect(bare.opens).toBe(0);

    const unrelated = new TrackingStore();
    const elsewhere = lookupOf({ glade_id: { id: "doc.other" }, profile: "text_crdt" });
    expect(() => new GlialBinder(unrelated, "local", elsewhere).mount(decl("doc.body", "crdt"), FILL)).toThrow(today);
    expect(unrelated.opens).toBe(0);
  });

  it("refuses a lookup answer keyed to another glade id", () => {
    const store = new TrackingStore();
    const misKeyed: ShapeProfileLookup = () => ({ glade_id: { id: "doc.other" }, profile: "text_crdt" });
    const binder = new GlialBinder(store, "alice", misKeyed);

    expect(() => binder.mount(decl("doc.body", "crdt"), FILL, undefined, { crdtProfile: "text_crdt" }))
      .toThrow(/declaration of doc\.other/);
    expect(store.opens).toBe(0);
  });

  it("does not read the lookup for a non-crdt mount", () => {
    const refuse: ShapeProfileLookup = (gladeId) => {
      throw new Error(`lookup read for ${gladeId}`);
    };
    const binder = new GlialBinder(undefined, "alice", refuse);

    expect(binder.mount(decl("doc.title", "value"), FILL).instance.decl.shape).toBe("value");
    expect(binder.mount(decl("doc.files", "swmr"), FILL).instance.decl.shape).toBe("swmr");
  });
});
