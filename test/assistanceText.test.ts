import { expect, it, vi } from "vitest";
import { GripAssistance, versionedTextDocuments } from "../src/assistance/grip";

function setup() {
  let count = 0;
  const doc = { value: { text: "original draft", version: 1, ready: true, pending: 0, status: "connected" },
    replace: vi.fn((text: string, version: number) => { if (version !== doc.value.version) throw Error("Draft changed"); doc.value = { ...doc.value, text, version: version + 1 }; }) };
  const documents = new Map([["proposal", doc]]);
  const mirror = { get: () => ({ proposal: { text: "stale mirror", version: 0, ready: true, pending: 0, status: "connected" } }), set: vi.fn(), update: vi.fn() };
  const grip = { name: "Documents", key: "app:Documents" }, context = {}, tap = { getValueControllers: () => new Map([[grip, mirror]]) };
  const node = { id: "home", get_context: () => context, producers: new Map([[grip, { tap }]]), consumers: new Map() };
  const controller = versionedTextDocuments(() => documents);
  const graph = { getGraph: () => new Map([["home", node]]) };
  const options = { id: () => `ref-${++count}`, controller: () => controller };
  return { doc, documents, mirror, graph, options };
}

it("discovers document text without per-field registration and writes through the normal versioned controller", () => {
  const f = setup(), values = new GripAssistance(f.graph, f.options);
  const entries = values.read("pair"), text = entries.find(v => v.path.join("/") === "proposal/text")!;
  expect(text).toMatchObject({ value: "original draft", writable: true });
  for (const field of ["version", "ready", "pending", "status"]) {
    expect(entries.find(v => v.path.join("/") === `proposal/${field}`)).toMatchObject({ writable: false });
    expect(entries.find(v => v.path.join("/") === `proposal/${field}`)?.ref).toBeUndefined();
  }
  values.prepareWrite({ ref: text.ref, value: "a quick brown fox jumps over the lazy dog" }, "pair")();
  expect(f.doc.replace).toHaveBeenCalledWith("a quick brown fox jumps over the lazy dog", 1);
  expect(f.mirror.update).not.toHaveBeenCalled(); expect(f.mirror.set).not.toHaveBeenCalled();
});

it("rejects stale versions, replaced documents and revoked refs without modifying text", () => {
  const f = setup(), values = new GripAssistance(f.graph, f.options);
  const ref = values.read("pair").find(v => v.path.join("/") === "proposal/text")!.ref;
  const commit = values.prepareWrite({ ref, value: "stale" }, "pair");
  f.doc.replace("other edit", 1);
  expect(() => commit()).toThrow(/changed/i); expect(f.doc.value.text).toBe("other edit");
  f.documents.set("proposal", { ...f.doc, replace: vi.fn() });
  expect(() => values.prepareWrite({ ref, value: "retargeted" }, "pair")).toThrow(/reference/i);
  const current = values.read("pair").find(v => v.path.join("/") === "proposal/text")!.ref;
  expect(() => values.prepareWrite({ ref: current, value: "revoked" }, "different-pair")).toThrow(/reference/i);
});

it("honors text/subtree exclusions before reading the excluded text and keeps disconnected text read-only", () => {
  const f = setup(); let reads = 0;
  Object.defineProperty(f.doc.value, "text", { enumerable: true, get() { reads++; throw Error("excluded text read"); } });
  const values = new GripAssistance(f.graph, { ...f.options, exclude: l => l.path[1] === "text" });
  expect(values.read("pair").some(v => v.path[1] === "text")).toBe(false); expect(reads).toBe(0);
  const hidden = new GripAssistance(f.graph, { ...f.options, exclude: l => l.path[0] === "proposal" });
  expect(hidden.read("pair").some(v => v.path[0] === "proposal")).toBe(false); expect(reads).toBe(0);
  f.doc.value = { text: "offline", version: 2, ready: false, pending: 0, status: "offline" };
  const offline = new GripAssistance(f.graph, f.options).read("pair").find(v => v.path[1] === "text");
  expect(offline).toMatchObject({ writable: false, value: "offline" });
});
