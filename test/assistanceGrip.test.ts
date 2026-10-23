import { expect, it, vi } from "vitest";
import { GripAssistance } from "../src/assistance/grip.ts";

function fixture() {
  let state: any = { left: "a", right: "b", drafts: { note: "editable" }, secret: { password: "hidden" } };
  const grip = { name: "Working", key: "app:Working" }, context = {};
  const controller = { get: vi.fn(() => state), set: (v: any) => { state = v; }, update: (fn: (v: any) => any) => { state = fn(state); } };
  const tap = { getValueControllers: () => new Map([[grip, controller]]) };
  const node = { id: "one", get_context: () => context, producers: new Map([[grip, { tap }]]), consumers: new Map() };
  const nodes = new Map([["one", node]]); let seq = 0;
  const graph = { getGraph: () => nodes };
  return { graph, nodes, node, grip, controller, tap, get: () => state, id: () => `ref-${++seq}` };
}
it("read-only policy retains readable values, defaults other leaves on and revokes old references before commit", () => {
  const f = fixture(); let readonly = false;
  const a = new GripAssistance(f.graph, { id: f.id, readonly: x => readonly && x.path[0] === "drafts" });
  const before = a.read("pair"), draft = before.find(v => v.path.join("/") === "drafts/note")!;
  const commit = a.prepareWrite({ ref: draft.ref, value: "bad" }, "pair"); readonly = true;
  expect(a.read("pair").find(v => v.path.join("/") === "drafts/note")).toMatchObject({ value: "editable", writable: false });
  expect(a.read("pair").find(v => v.path.join("/") === "left")?.writable).toBe(true);
  expect(() => commit()).toThrow(/reference/); expect(f.get().drafts.note).toBe("editable");
});
it("discovers all scalar leaves by default, preserves siblings and rejects raw object replacements", () => {
  const f = fixture(), a = new GripAssistance(f.graph, { id: f.id });
  const values = a.read("pair-1");
  expect(values.find(v => v.path.join("/") === "drafts/note")?.writable).toBe(true);
  const left = values.find(v => v.path.join("/") === "left")!;
  a.prepareWrite({ ref: left.ref, value: "b" }, "pair-1")();
  expect(f.get()).toMatchObject({ left: "b", right: "b", drafts: { note: "editable" } });
  expect(() => a.prepareWrite({ ref: left.ref, value: { left: "x" } }, "pair-1")).toThrow(/type|scalar/);
  expect(values.some(v => v.path.length === 0 && v.writable)).toBe(false);
});
it("excludes contexts, values and nested subtrees before reads; no parent value leaks", () => {
  const f = fixture(); let privateReads = 0;
  Object.defineProperty(f.get(), "secret", { enumerable: true, get() { privateReads++; throw Error("secret read"); } });
  const a = new GripAssistance(f.graph, { id: f.id, exclude: x => x.path[0] === "secret" });
  const values = a.read("pair"); expect(privateReads).toBe(0);
  expect(JSON.stringify(values)).not.toContain("password"); expect(values.some(v => v.path.includes("secret"))).toBe(false);
  a.prepareWrite({ ref: values.find(v => v.path[0] === "left")!.ref, value: "new" }, "pair")(); expect(privateReads).toBe(0);
  f.controller.get.mockClear();
  expect(new GripAssistance(f.graph, { id: f.id, exclude: x => x.grip === "Working" }).read("pair")).toEqual([]);
  expect(f.controller.get).not.toHaveBeenCalled();
  expect(new GripAssistance(f.graph, { id: f.id, excludeContext: id => id === "one" }).read("pair")).toEqual([]);
  expect(f.controller.get).not.toHaveBeenCalled();
});
it("keeps exact contexts separate and rejects stale references after pairing/topology changes", () => {
  const f = fixture(), other = fixture(); other.node.id = "two"; f.nodes.set("two", other.node);
  const a = new GripAssistance(f.graph, { id: f.id });
  const left = a.read("pair").find(v => v.context === "two" && v.path[0] === "left")!;
  a.prepareWrite({ ref: left.ref, value: "two-only" }, "pair")(); expect(other.get().left).toBe("two-only"); expect(f.get().left).toBe("a");
  expect(() => a.prepareWrite({ ref: left.ref, value: "bad" }, "new-pair")).toThrow(/reference/);
  const ref = a.read("new-pair").find(v => v.context === "two" && v.path[0] === "left")!.ref;
  f.nodes.delete("two"); expect(() => a.prepareWrite({ ref, value: "bad" }, "new-pair")).toThrow(/reference/);
});
it("reports computed output read-only and unsupported runtime values explicitly", () => {
  const f = fixture(), computed = { name: "Computed", key: "app:Computed" };
  f.node.producers.set(computed, { tap: {} } as any);
  f.node.consumers.set(computed, { deref: () => ({ get: () => 42 }) });
  f.get().bad = new Date(); f.get().fn = () => "private";
  const a = new GripAssistance(f.graph, { id: f.id }), values = a.read("pair");
  const out = values.find(v => v.grip === "Computed")!;
  expect(out).toMatchObject({ writable: false, value: 42 }); expect(out.ref).toBeUndefined();
  expect(values.find(v => v.path[0] === "bad")?.error).toMatch(/unsupported/);
  expect(values.find(v => v.path[0] === "fn")?.error).toMatch(/unsupported/);
  expect(() => a.prepareWrite({ ref: out.ref, value: 8 }, "pair")).toThrow();
});
