// Binder v0 — the instance registry: refcounted mount/unmount, several
// instances per decl, attach-to-live (no new fold), isolated teardown. Mirrors
// the s-stack-multi atlas trace (ggg-viz) behaviorally.

import { describe, expect, it } from "vitest";
import type { BindingDecl } from "@owebeeone/glade-decl";
import { GlialBinder } from "../src/binder.ts";
import { MemoryStoreEngine } from "../src/store.ts";
import type { Fill } from "../src/instance.ts";
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
    retention: { policy: "from_cursor", ttl_ms: null },
  };
}

const DOC1: Fill = { domain: "doc-1" };
const DOC2: Fill = { domain: "doc-2" };

describe("GlialBinder — refcounted instance registry", () => {
  it("one decl, two fills => two independent live instances", () => {
    const b = new GlialBinder();
    const col = decl("notes.column", "log");
    const a = b.mount(col, DOC1);
    const c = b.mount(col, DOC2);
    expect(b.instanceCount).toBe(2);
    expect(a.instance).not.toBe(c.instance);

    a.instance.write(utf8("A only"));
    // doc-2's fold never sees doc-1's op — separate assembly state.
    let doc2seen: InstanceEvent | undefined;
    b.mount(col, DOC2, (e) => (doc2seen = e));
    expect(doc2seen!.records).toEqual([]);
  });

  it("a mount of a LIVE fill attaches: refcount++ and no new instance/fold", () => {
    const b = new GlialBinder();
    const col = decl("notes.column", "log");
    const first = b.mount(col, DOC1);
    first.instance.write(utf8("- shared entry"));

    // third consumer, same fill: attaches to the existing instance.
    let attached: InstanceEvent | undefined;
    const second = b.mount(col, DOC1, (e) => (attached = e));
    expect(b.instanceCount).toBe(1);
    expect(second.instance).toBe(first.instance);
    expect(b.refcountOf(col, DOC1)).toBe(2);
    // the newcomer got a REFRESH off the existing fold (no recompute needed).
    expect(attached!.envelope.kind).toBe("refresh");
    expect(attached!.records!.map((r) => fromUtf8(r.payload))).toEqual(["- shared entry"]);
  });

  it("unmount is refcounted; teardown is per-instance and isolates siblings", () => {
    const b = new GlialBinder();
    const col = decl("notes.column", "log");
    const a1 = b.mount(col, DOC1);
    const a2 = b.mount(col, DOC1);
    const bDoc = b.mount(col, DOC2);
    expect(b.refcountOf(col, DOC1)).toBe(2);
    expect(b.instanceCount).toBe(2);

    a2.unmount(); // instance A retained — a1 still holds it
    expect(b.refcountOf(col, DOC1)).toBe(1);
    expect(b.isLive(col, DOC1)).toBe(true);

    bDoc.unmount(); // instance B refcount -> 0 -> torn down
    expect(b.isLive(col, DOC2)).toBe(false);
    expect(b.isLive(col, DOC1)).toBe(true); // sibling unaffected
    expect(b.instanceCount).toBe(1);

    a1.unmount();
    expect(b.instanceCount).toBe(0);
  });

  it("unmount is idempotent (double-unmount does not underflow the refcount)", () => {
    const b = new GlialBinder();
    const col = decl("notes.column", "log");
    const a1 = b.mount(col, DOC1);
    const a2 = b.mount(col, DOC1);
    a2.unmount();
    a2.unmount();
    expect(b.refcountOf(col, DOC1)).toBe(1);
    a1.unmount();
    expect(b.instanceCount).toBe(0);
  });
});
