// Store-only assembly + rich events (s-stack-local): persistence with ZERO
// glade configured, folds run inside glial, and the change envelope carries the
// consumer's choice (refresh whole value / delta appended entries).

import { describe, expect, it } from "vitest";
import type { BindingDecl } from "@owebeeone/glade-decl";
import { GlialBinder } from "../src/binder.ts";
import { MemoryStoreEngine } from "../src/store.ts";
import { instanceKey, type Fill } from "../src/instance.ts";
import type { InstanceEvent } from "../src/events.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

function decl(id: string, shape: "value" | "log"): BindingDecl {
  return {
    glade_id: { id },
    shape,
    authority: "share",
    source: null,
    domain: "document",
    zone: "commons",
    retention: { policy: "latest", ttl_ms: null },
  };
}
const DOC1: Fill = { domain: "doc-1" };

describe("store-only path — value shape", () => {
  it("persists and refreshes with no glade anywhere", () => {
    const b = new GlialBinder();
    const d = decl("notes.title", "value");
    const events: InstanceEvent[] = [];
    const m = b.mount(d, DOC1, (e) => events.push(e));
    expect(m.instance.connected).toBe(false); // zero glade configured

    expect(events[0].empty).toBe(true); // initial refresh: empty register
    m.instance.write(utf8("first"));
    m.instance.write(utf8("second"));

    const last = events[events.length - 1];
    expect(last.envelope.shape).toBe("value");
    expect(last.envelope.kind).toBe("refresh");
    expect(fromUtf8(last.value!)).toBe("second"); // lww: latest write wins
  });
});

describe("store-only path — log shape", () => {
  it("emits a delta of the appended entries on each write", () => {
    const b = new GlialBinder();
    const d = decl("notes.body", "log");
    const events: InstanceEvent[] = [];
    const m = b.mount(d, DOC1, (e) => events.push(e));

    expect(events[0].envelope.kind).toBe("refresh"); // mount refresh (empty)
    m.instance.write(utf8("- line 1"));
    m.instance.write(utf8("- line 2"));

    const deltas = events.filter((e) => e.envelope.kind === "delta");
    expect(deltas.map((e) => e.delta!.map((r) => fromUtf8(r.payload)))).toEqual([
      ["- line 1"],
      ["- line 2"],
    ]);
    // whole assembled list rides along for a consumer that wants a refresh.
    expect(deltas[1].records!.map((r) => fromUtf8(r.payload))).toEqual(["- line 1", "- line 2"]);
    // base_seq points at what the delta applies against.
    expect(deltas[1].envelope.base_seq).toBe(1n);
  });
});

describe("hydration — the browser is a replica of itself (s-stack-local SL3)", () => {
  it("a mount over a store with persisted ops refreshes from the cached fold", () => {
    const store = new MemoryStoreEngine();
    const d = decl("notes.body", "log");
    // Pre-seed the instance store as if a prior session had persisted 2 ops.
    const key = instanceKey(d.glade_id.id, DOC1);
    const is = store.open(key);
    is.append({ origin: "local", seq: 1, lamport: 1, prev: null, payload: utf8("- persisted 1") });
    is.append({ origin: "local", seq: 2, lamport: 2, prev: null, payload: utf8("- persisted 2") });

    const b = new GlialBinder(store);
    let first: InstanceEvent | undefined;
    b.mount(d, DOC1, (e) => (first ??= e));
    expect(first!.envelope.kind).toBe("refresh");
    expect(first!.records!.map((r) => fromUtf8(r.payload))).toEqual(["- persisted 1", "- persisted 2"]);
  });
});
