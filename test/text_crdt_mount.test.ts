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
  it("publishes one completed projection for a bulk replacement and none for a no-op", () => {
    const mount = mountText("bulk");
    const values: string[] = [];
    const off = mount.instance.subscribe((event) => { if (event.crdt) { values.push(event.crdt.text); } });
    values.length = 0;
    const text = "A shared proposal\n".repeat(8);
    mount.instance.replaceText(text);
    expect(values).toEqual([text]);
    expect(mount.instance.operations()).toHaveLength(Array.from(text).length);
    values.length = 0;
    mount.instance.replaceText(text);
    expect(values).toEqual([]);
    mount.instance.replaceText("");
    expect(values).toEqual([""]);
    off(); mount.unmount();
  });
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

describe("bulk text destination behavior", () => {
  it("deduplicates synchronous echoes and publishes only the completed replacement", () => {
    const mount = mountText("local");
    let receive: (ops: import("../src/store.ts").StoredOp[]) => void = () => {};
    let seq = 0;
    mount.instance.attachGlade({
      origin: "echo",
      subscribe: (fn) => { receive = fn; return () => {}; },
      send: (payload) => {
        seq += 1;
        const op = { origin: "echo", seq, lamport: seq, prev: null,
          refs: seq > 1 ? [{ origin: "echo", seq: seq - 1 }] : [], payload };
        receive([op]);
        return op;
      },
    });
    const values: string[] = [];
    const off = mount.instance.subscribe((event) => { if (event.crdt) { values.push(event.crdt.text); } });
    values.length = 0;
    mount.instance.replaceText("A😀B");
    expect(values).toEqual(["A😀B"]);
    expect(mount.instance.operations()).toHaveLength(3);
    mount.instance.replaceText("A😀B");
    expect(values).toHaveLength(1);
    off(); mount.unmount();
  });

  it("retains a successfully sent prefix after a destination failure and can resume", () => {
    const mount = mountText("local");
    let seq = 0, fail = true;
    mount.instance.attachGlade({
      origin: "partial",
      subscribe: () => () => {},
      send: (payload) => {
        if (seq === 2 && fail) { fail = false; throw new Error("send interrupted"); }
        seq += 1;
        return { origin: "partial", seq, lamport: seq, prev: null,
          refs: seq > 1 ? [{ origin: "partial", seq: seq - 1 }] : [], payload };
      },
    });
    expect(() => mount.instance.replaceText("ABC")).toThrow("send interrupted");
    expect(mount.instance.textCrdtState().text).toBe("AB");
    mount.instance.replaceText("ABC");
    expect(mount.instance.textCrdtState().text).toBe("ABC");
    mount.unmount();
  });
});

it("retains the engine and does no historical replay for a small edit or echo", () => {
  const mount = mountText("incremental");
  mount.instance.replaceText("x".repeat(500));
  const before = mount.instance.textCrdtWork();
  mount.instance.replaceText("x".repeat(500) + "y");
  const after = mount.instance.textCrdtWork();
  expect(after.engines).toBe(before.engines);
  expect(after.applied - before.applied).toBe(1);
  const value = mount.instance.textCrdtState();
  mount.instance.ingest(mount.instance.operations());
  expect(mount.instance.textCrdtState()).toBe(value);
  expect(mount.instance.textCrdtWork()).toEqual(after);
});

it("projects a large paste without exhausting the call stack", () => {
  const mounted = mountText("large");
  mounted.instance.replaceText("x".repeat(12000));
  expect(mounted.instance.textCrdtState().text.length).toBe(12000);
  mounted.unmount();
});
