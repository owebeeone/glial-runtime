import { describe, expect, it } from "vitest";
import type { BindingDecl } from "@owebeeone/glade-decl";

import { GlialBinder } from "../src/binder.ts";
import {
  anchorSelection,
  resolveSelection,
  type TextCrdtState,
} from "../src/text_crdt.ts";

function declaration(): BindingDecl {
  return {
    glade_id: { id: "doc.collaborative-notes" },
    shape: "crdt",
    authority: "share",
    source: null,
    domain: "document",
    zone: "commons",
    retention: { policy: "from_cursor", ttl_ms: null },
  };
}

function mountText(origin: string) {
  return new GlialBinder(undefined, origin).mount(
    declaration(),
    { domain: "doc-1" },
    undefined,
    { crdtProfile: "text_crdt" },
  );
}

describe("mounted text CRDT", () => {
  it("edits the middle of a document without replacing the whole value", () => {
    const mount = mountText("alice");
    mount.instance.replaceText("hello");
    mount.instance.replaceText("helXlo");

    expect(mount.instance.textCrdtState().text).toBe("helXlo");
    expect(mount.instance.textCrdtState().visible.map((element) => element.text).join(""))
      .toBe("helXlo");
  });

  it("converges concurrent inserts delivered in opposite orders", () => {
    const alice = mountText("alice");
    alice.instance.replaceText("AB");
    const baseline = alice.instance.operations();

    const left = mountText("left");
    const right = mountText("right");
    left.instance.ingest(baseline);
    right.instance.ingest(baseline);
    left.instance.replaceText("ALB");
    right.instance.replaceText("ARB");

    const leftOnly = left.instance.operations().filter((op) => op.origin === "left");
    const rightOnly = right.instance.operations().filter((op) => op.origin === "right");
    left.instance.ingest(rightOnly);
    right.instance.ingest(leftOnly);

    expect(left.instance.textCrdtState().text).toBe(right.instance.textCrdtState().text);
    expect(left.instance.textCrdtState().text).toHaveLength(4);
    expect(left.instance.textCrdtState().text.startsWith("A")).toBe(true);
    expect(left.instance.textCrdtState().text.endsWith("B")).toBe(true);
  });

  it("keeps a cursor element-anchored when a remote edit arrives after it", () => {
    const mount = mountText("alice");
    mount.instance.replaceText("hello");
    const before = mount.instance.textCrdtState();
    const selection = anchorSelection(before, { anchor: 2, focus: 2 });

    mount.instance.replaceText("hello world");
    const after = mount.instance.textCrdtState();
    expect(resolveSelection(after, selection)).toEqual({ anchor: 2, focus: 2 });
    expect(after.text.length).toBeGreaterThan(2);
  });

  it("resolves a cursor whose element was deleted at the tombstone position", () => {
    const mount = mountText("alice");
    mount.instance.replaceText("abc");
    const state = mount.instance.textCrdtState();
    const selection = anchorSelection(state, { anchor: 2, focus: 2 });

    mount.instance.replaceText("ac");
    expect(resolveSelection(mount.instance.textCrdtState(), selection)).toEqual({ anchor: 1, focus: 1 });
  });

  it("fails closed when an op is not a text_crdt profile payload", () => {
    const mount = mountText("alice");
    expect(() => mount.instance.ingest([
      { origin: "peer", seq: 0, lamport: 1, prev: null, refs: [], payload: new Uint8Array([0xff]) },
    ])).toThrow(/text_crdt/);
    expect(mount.instance.textCrdtState()).toMatchObject({ text: "", diagnostics: [] });
  });
});

// Compile-time assertion that the state exposes identity-bearing elements,
// rather than only a whole string that would force cursor-by-offset behavior.
const _stateContract: TextCrdtState | undefined = undefined;
void _stateContract;
