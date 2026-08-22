import { describe, expect, it } from "vitest";
import type { BindingDecl, Shape } from "@owebeeone/glade-decl";

import { GlialBinder } from "../src/binder.ts";
import { MemoryStoreEngine, type InstanceStore, type StoreEngine } from "../src/store.ts";
import {
  glialShapeCapabilities,
  requireShapeAdapter,
  UnsupportedShapeError,
} from "../src/shapes.ts";
import {
  attachSupplier,
  type ExchangeReply,
  type ExchangeRequest,
  type SupplierOp,
  type SupplierSession,
  type SupplierSurface,
} from "../src/supplier/index.ts";

function decl(shape: Shape): BindingDecl {
  return {
    glade_id: { id: `test.${shape}` },
    shape,
    authority: "share",
    source: null,
    domain: "document",
    zone: "commons",
    retention: { policy: "latest", ttl_ms: null },
  };
}

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

class InertSupplierSession implements SupplierSession {
  readonly origin = "test";
  subscriptions = 0;

  subscribe(): void {
    this.subscriptions += 1;
  }
  onExchangeReq(_handler: (req: ExchangeRequest) => void): () => void {
    return () => {};
  }
  respondExchange(_reply: ExchangeReply): void {}
  append(): SupplierOp {
    throw new Error("append must not be reached");
  }
  onOps(): () => void {
    return () => {};
  }
}

function surface(shape: Shape): SupplierSurface {
  return { glade_id: { id: `test.${shape}` }, shape, share: "test" };
}

describe("Glial shape capability dispatch", () => {
  it("advertises exactly the tested delivery adapters", () => {
    expect(glialShapeCapabilities().map((cap) => cap.shape)).toEqual(["atom", "crdt", "value", "log", "stream", "text_crdt"]);
    expect(requireShapeAdapter("atom").contractVersion).toBe("atom.oracle/v1");
    expect(requireShapeAdapter("value").contractVersion).toBe("value.oracle/v0");
    expect(requireShapeAdapter("log").contractVersion).toBe("log.oracle/v0");
    expect(requireShapeAdapter("stream").contractVersion).toBe("stream.oracle/v1");
    expect(requireShapeAdapter("crdt").contractVersion).toBe("crdt.oracle/v1");
    expect(requireShapeAdapter("text_crdt").contractVersion).toBe("text_crdt.profile/v1");
  });

  it.each(["message", "exchange", "window"] as const)(
    "rejects %s before opening an instance store",
    (shape) => {
      const store = new TrackingStore();
      const binder = new GlialBinder(store);
      expect(() => binder.mount(decl(shape), { domain: "doc" })).toThrow(UnsupportedShapeError);
      expect(store.opens).toBe(0);
      expect(binder.instanceCount).toBe(0);
    },
  );

  it("keeps atom out of the multi-writer fold/mount path", () => {
    const store = new TrackingStore();
    const binder = new GlialBinder(store);
    expect(() => binder.mount(decl("atom" as Shape), { domain: "doc" })).toThrow(
      expect.objectContaining({ code: "GLIAL_UNSUPPORTED_SHAPE", shape: "atom", operation: "mount" }),
    );
    expect(store.opens).toBe(0);
  });

  it("keeps stream out of the durable multi-writer fold/mount path", () => {
    const store = new TrackingStore();
    const binder = new GlialBinder(store);
    expect(() => binder.mount(decl("stream"), { domain: "doc" })).toThrow(
      expect.objectContaining({ code: "GLIAL_UNSUPPORTED_SHAPE", shape: "stream", operation: "mount" }),
    );
    expect(store.opens).toBe(0);
  });

  it("keeps exchange and delivery serving on separate exact paths", () => {
    const session = new InertSupplierSession();
    const supplier = attachSupplier(session);

    expect(() => supplier.serveShare(surface("exchange"), {})).toThrow(
      expect.objectContaining({ code: "GLIAL_UNSUPPORTED_SHAPE", operation: "serveShare" }),
    );
    expect(() => supplier.serveExchange(surface("value"), () => ({}))).toThrow(
      expect.objectContaining({ code: "GLIAL_UNSUPPORTED_SHAPE", operation: "serveExchange" }),
    );
    expect(session.subscriptions).toBe(0);
  });
});
