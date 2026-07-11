// The typed manifest (GLP-0006 P0.S5a) — the declared-surface COMPILE WALL.
// Runtime: `defineManifest` builds frozen, BindingDecl-shaped Surface handles
// that the kernel mount, the grip adapter, and the supplier accept unchanged.
// Type-level (`@ts-expect-error`, gated by `tsc --noEmit`): an undefined /
// typo'd surface is a build error BY CONSTRUCTION.

import { describe, expect, it } from "vitest";

import { defineManifest, type Surface } from "../src/manifest.ts";
import { GlialBinder } from "../src/binder.ts";
import type { Fill } from "../src/instance.ts";
import {
  attachSupplier,
  type ExchangeReply,
  type ExchangeRequest,
  type SupplierOp,
  type SupplierSession,
} from "../src/supplier/index.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

// The app's manifest — consumers reference `M.notes`, never "app:notes".
const M = defineManifest({
  notes: { id: "app:notes", shape: "log", share: "s" },
  title: { id: "app:title", shape: "value", share: "s", domain: "account", zone: "private" },
  gwzOps: { id: "app:gwz.ops", shape: "exchange", share: "ws-razel" },
});

const DOC1: Fill = { domain: "doc-1" };

describe("defineManifest — frozen, typed, BindingDecl-shaped handles", () => {
  it("builds handles carrying the glade id, shape, share, and decl anchor defaults", () => {
    expect(M.notes.glade_id.id).toBe("app:notes");
    expect(M.notes.shape).toBe("log");
    expect(M.notes.share).toBe("s");
    // BindingDecl anchor defaults
    expect(M.notes.authority).toBe("share");
    expect(M.notes.domain).toBe("document");
    expect(M.notes.zone).toBe("commons");
    expect(M.notes.source).toBeNull();
    expect(M.notes.retention).toEqual({ policy: "latest", ttl_ms: null });
    // explicit overrides land
    expect(M.title.domain).toBe("account");
    expect(M.title.zone).toBe("private");
  });

  it("freezes each handle and the manifest (surfaces are immutable references)", () => {
    expect(Object.isFrozen(M)).toBe(true);
    expect(Object.isFrozen(M.notes)).toBe(true);
    expect(Object.isFrozen(M.notes.glade_id)).toBe(true);
  });
});

describe("the typed handle is accepted by glial's mount / adapter / supplier APIs", () => {
  it("binder.mount(surface, fill) accepts a Surface (it IS a BindingDecl)", () => {
    const binder = new GlialBinder();
    const m = binder.mount(M.notes, DOC1);
    expect(m.instance.decl.glade_id.id).toBe("app:notes");
    expect(binder.isLive(M.notes, DOC1)).toBe(true);
    m.unmount();
  });

  it("supplier.serveExchange(surface, handler) accepts a Surface", async () => {
    class FakeSession implements SupplierSession {
      origin = "supplier";
      subs: Array<{ share: string; gladeId: string }> = [];
      replies: ExchangeReply[] = [];
      private reqHandler?: (req: ExchangeRequest) => void;
      subscribe(share: string, gladeId: string): Promise<void> {
        this.subs.push({ share, gladeId });
        return Promise.resolve();
      }
      onExchangeReq(h: (req: ExchangeRequest) => void): () => void {
        this.reqHandler = h;
        return () => (this.reqHandler = undefined);
      }
      respondExchange(reply: ExchangeReply): void {
        this.replies.push(reply);
      }
      append(share: string, gladeId: string, _s: string, payload: Uint8Array, key?: Uint8Array): SupplierOp {
        return { share, glade_id: gladeId, key: key ?? new Uint8Array(), origin: "supplier", seq: 1, payload };
      }
      onOps(): () => void {
        return () => {};
      }
      deliver(req: ExchangeRequest): void {
        this.reqHandler?.(req);
      }
    }
    const session = new FakeSession();
    attachSupplier(session).serveExchange(M.gwzOps, (req) => ({ payload: utf8(`pong:${fromUtf8(req.payload)}`) }));
    await new Promise<void>((r) => setTimeout(r, 0));
    // subscribed on the handle's (share, glade id) — the manifest drove the wire.
    expect(session.subs).toEqual([{ share: "ws-razel", gladeId: "app:gwz.ops" }]);
    session.deliver({ share: "ws-razel", glade_id: "app:gwz.ops", corr: "c1", payload: utf8("status") });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fromUtf8(session.replies[0]!.payload!)).toBe("pong:status");
  });
});

describe("the compile wall — undefined surfaces are TS build errors (tsc-gated)", () => {
  it("references a defined surface; a typo'd/undefined one fails to compile", () => {
    // Positive: a declared surface is a usable typed value.
    const notes: Surface<"log"> = M.notes;
    expect(notes.shape).toBe("log");

    // @ts-expect-error — an undefined surface is a compile error (THE wall).
    void M.nope;
    // @ts-expect-error — a typo is a compile error, not a silent string.
    void M.note;

    // The per-surface Shape literal is preserved (enables shape-safe serving).
    const exShape: "exchange" = M.gwzOps.shape;
    expect(exShape).toBe("exchange");
  });
});
