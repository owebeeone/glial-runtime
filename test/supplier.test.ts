// The supplier kit (GLP-0006 P0.S4) — the authority-side counterpart of the
// grip adapter. Tested ws-free against a FAKE SupplierSession that models the
// node's two mechanisms (`GladeSupplierModel.md` §2): the exchange provider map
// (serveExchange = attach + answer ExchangeReq, corr preserved) and value/log
// op-serving (serveShare = publish ops + fold inbound; the claim is node-side,
// not an attach). One test drives the REAL in-process `@glade/client-ts`
// Session so the share path exercises the real fold/store/chain (GAP-4's
// established fallback — no glade-node binary; the parallel glade work owns the
// provider-side client-ts hooks noted in the kit).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  attachSupplier,
  Supplier,
  type ExchangeReply,
  type ExchangeRequest,
  type ScheduleFn,
  type SupplierOp,
  type SupplierSession,
  type SupplierSurface,
} from "../src/supplier/index.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

import { loadSchema } from "../../glade/client-ts/src/taut/schema.ts";
import { Session } from "../../glade/client-ts/src/session.ts";

const surface = (id: string, shape: SupplierSurface["shape"], share = "s"): SupplierSurface => ({
  glade_id: { id },
  shape,
  share,
});

// A microtask/macrotask flush — the exchange handler answers through a Promise
// chain (handler -> respond), so tests await one turn of the loop.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---- fake session: the node's provider + op fan-out, ws-free ---------------

class FakeSession implements SupplierSession {
  origin = "supplier";
  readonly subs: Array<{ share: string; gladeId: string }> = [];
  readonly replies: ExchangeReply[] = [];
  readonly published: SupplierOp[] = [];
  helloCount = 0;
  helloPrincipal?: string;

  private reqHandler?: (req: ExchangeRequest) => void;
  private opsHandler?: (ops: SupplierOp[]) => void;
  private dropHandler?: () => void;
  private seq = 0;

  /** When set, subscribe() rejects N times then resolves — drives the reattach
   *  backoff test through the failure arm. */
  subscribeRejects = 0;

  subscribe(share: string, gladeId: string): Promise<void> {
    if (this.subscribeRejects > 0) {
      this.subscribeRejects -= 1;
      return Promise.reject(new Error("subscribe failed"));
    }
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
  append(share: string, gladeId: string, _shape: string, payload: Uint8Array, key?: Uint8Array): SupplierOp {
    const op: SupplierOp = { share, glade_id: gladeId, key: key ?? new Uint8Array(), origin: this.origin, seq: ++this.seq, payload };
    this.published.push(op);
    return op;
  }
  onOps(h: (ops: SupplierOp[]) => void): () => void {
    this.opsHandler = h;
    return () => (this.opsHandler = undefined);
  }
  hello(principal: string): void {
    this.helloCount += 1;
    this.helloPrincipal = principal;
  }
  onDrop(h: () => void): () => void {
    this.dropHandler = h;
    return () => (this.dropHandler = undefined);
  }

  // ---- test drivers ----
  deliverReq(req: ExchangeRequest): void {
    this.reqHandler?.(req);
  }
  deliverOps(ops: SupplierOp[]): void {
    this.opsHandler?.(ops);
  }
  hasReqHandler(): boolean {
    return this.reqHandler !== undefined;
  }
  hasOpsHandler(): boolean {
    return this.opsHandler !== undefined;
  }
  /** Model a link drop: the connection's hooks are gone; fire the drop signal. */
  drop(): void {
    this.reqHandler = undefined;
    this.opsHandler = undefined;
    this.dropHandler?.();
  }
}

// ---- serveExchange: attach as provider, answer with corr -------------------

describe("supplier — serveExchange (the exchange provider mechanism)", () => {
  it("subscribes as the provider and answers an inbound ExchangeReq, corr preserved", async () => {
    const session = new FakeSession();
    const sup = attachSupplier(session);
    sup.serveExchange(surface("gwz.ops", "exchange"), (req) => ({ payload: utf8(`pong:${fromUtf8(req.payload)}`) }));
    await flush();

    expect(session.subs).toEqual([{ share: "s", gladeId: "gwz.ops" }]); // attached
    session.deliverReq({ share: "s", glade_id: "gwz.ops", corr: "c1", payload: utf8("gwz.status") });
    await flush();

    expect(session.replies).toHaveLength(1);
    const r = session.replies[0]!;
    expect(r.corr).toBe("c1");
    expect(r.ok).toBe(true);
    expect(fromUtf8(r.payload!)).toBe("pong:gwz.status");
  });

  it("a thrown handler answers ok:false with the reason as DATA, corr intact", async () => {
    const session = new FakeSession();
    attachSupplier(session).serveExchange(surface("gwz.ops", "exchange"), () => {
      throw new Error("boom");
    });
    await flush();
    session.deliverReq({ share: "s", glade_id: "gwz.ops", corr: "c7", payload: utf8("x") });
    await flush();

    const r = session.replies[0]!;
    expect(r).toMatchObject({ corr: "c7", ok: false });
    expect(r.error).toContain("boom");
    expect(r.payload).toBeUndefined();
  });

  it("only answers requests routed to its own surface (multiplex filter)", async () => {
    const session = new FakeSession();
    attachSupplier(session).serveExchange(surface("gwz.ops", "exchange"), () => ({ payload: utf8("mine") }));
    await flush();
    session.deliverReq({ share: "s", glade_id: "other.ops", corr: "c9", payload: utf8("x") });
    await flush();
    expect(session.replies).toHaveLength(0); // not ours — ignored
  });
});

// ---- serveShare: publish ops + fold inbound (NOT an attach) -----------------

describe("supplier — serveShare (value/log op-serving)", () => {
  it("publishes ops through the source controller and folds inbound ops", async () => {
    const session = new FakeSession();
    const sup = attachSupplier(session);
    const inbound: SupplierOp[] = [];
    sup.serveShare(surface("chat.lines", "log"), {
      onServe: (ctl) => {
        ctl.append(utf8("- hi"));
        ctl.append(utf8("- there"));
      },
      onOp: (op) => inbound.push(op),
    });
    await flush();

    // serving = op-appends into the surface stream
    expect(session.published.map((o) => fromUtf8(o.payload))).toEqual(["- hi", "- there"]);
    // inbound (another writer) folds into the source
    session.deliverOps([{ share: "s", glade_id: "chat.lines", key: new Uint8Array(), origin: "peer", seq: 1, payload: utf8("- yo") }]);
    expect(inbound.map((o) => fromUtf8(o.payload))).toEqual(["- yo"]);
    // an op for a different surface is filtered out
    session.deliverOps([{ share: "s", glade_id: "other", key: new Uint8Array(), origin: "peer", seq: 2, payload: utf8("- nope") }]);
    expect(inbound).toHaveLength(1);
  });

  it("wrong-shape controller use throws (set on a log, append on a value)", async () => {
    const session = new FakeSession();
    attachSupplier(session).serveShare(surface("chat.lines", "log"), {
      onServe: (ctl) => {
        expect(() => ctl.set(utf8("x"))).toThrow(/value-shape/);
      },
    });
    attachSupplier(session).serveShare(surface("ws.title", "value"), {
      onServe: (ctl) => {
        expect(() => ctl.append(utf8("x"))).toThrow(/log-shape/);
      },
    });
    await flush();
  });

  it("drives the REAL @glade/client-ts session: served ops converge and inbound folds", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = loadSchema(JSON.parse(readFileSync(join(here, "..", "..", "taut", "corpus", "glade.ir.json"), "utf8")));

    class LocalBus {
      private handlers = new Set<(ops: SupplierOp[]) => void>();
      publish(ops: SupplierOp[]): void {
        for (const h of [...this.handlers]) h(ops);
      }
      onOps(h: (ops: SupplierOp[]) => void): () => void {
        this.handlers.add(h);
        return () => this.handlers.delete(h);
      }
    }
    class MeshSession implements SupplierSession {
      readonly origin: string;
      constructor(private readonly sess: Session, private readonly bus: LocalBus) {
        this.origin = sess.origin;
      }
      subscribe(): Promise<void> {
        return Promise.resolve();
      }
      onExchangeReq(): () => void {
        return () => {};
      }
      respondExchange(): void {}
      append(share: string, gladeId: string, shape: string, payload: Uint8Array, key?: Uint8Array): SupplierOp {
        const op = this.sess.append(share, gladeId, shape, payload, key);
        this.bus.publish([op as unknown as SupplierOp]);
        return op as unknown as SupplierOp;
      }
      onOps(h: (ops: SupplierOp[]) => void): () => void {
        return this.bus.onOps((ops) => {
          this.sess.applyRemote(ops as never);
          h(ops);
        });
      }
    }

    const bus = new LocalBus();
    const supSess = new MeshSession(new Session(schema, "sup"), bus);
    const cliSess = new Session(schema, "cli");
    bus.onOps((ops) => cliSess.applyRemote(ops as never)); // a plain consumer folds served ops

    const inbound: SupplierOp[] = [];
    const sup = new Supplier(supSess);
    let ctlRef: { append(p: Uint8Array): SupplierOp } | undefined;
    sup.serveShare(surface("chat.lines", "log"), {
      onServe: (ctl) => (ctlRef = ctl),
      onOp: (op) => {
        if (op.origin !== "sup") inbound.push(op); // ignore our own echoes
      },
    });
    await flush();

    // the supplier serves two lines; the consumer converges them (real fold).
    ctlRef!.append(utf8("- a"));
    ctlRef!.append(utf8("- b"));
    const folded = cliSess.fold("s", "chat.lines", "log") as Uint8Array[];
    expect(folded.map(fromUtf8)).toEqual(["- a", "- b"]);

    // a consumer write reaches the supplier's source as an inbound op.
    const cliOp = cliSess.append("s", "chat.lines", "log", utf8("- c")) as unknown as SupplierOp;
    bus.publish([cliOp]);
    expect(inbound.map((o) => fromUtf8(o.payload))).toEqual(["- c"]);
  });
});

// ---- reattach-on-drop + clean detach ---------------------------------------

function fakeScheduler() {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  const schedule: ScheduleFn = (fn, ms) => {
    const call = { fn, ms };
    calls.push(call);
    return () => {
      const i = calls.indexOf(call);
      if (i >= 0) calls.splice(i, 1);
    };
  };
  return { schedule, calls, runNext: () => calls.shift()?.fn() };
}

describe("supplier — reattach-on-drop with backoff", () => {
  it("reattaches every serving after a drop and re-registers wire hooks", async () => {
    const session = new FakeSession();
    const { schedule, calls, runNext } = fakeScheduler();
    const sup = attachSupplier(session, { schedule, backoff: { initialMs: 100, factor: 2 } });
    sup.serveExchange(surface("gwz.ops", "exchange"), () => ({ payload: utf8("ok") }));
    await flush();
    expect(session.subs).toHaveLength(1);
    expect(session.hasReqHandler()).toBe(true);

    session.drop(); // link loss — the node drops the provider entry, hooks gone
    expect(session.hasReqHandler()).toBe(false);
    expect(calls[0]!.ms).toBe(100); // scheduled a reattach at the base delay

    runNext();
    await flush();
    expect(session.subs).toHaveLength(2); // re-subscribed
    expect(session.hasReqHandler()).toBe(true); // provider hook re-registered
  });

  it("backs off exponentially on consecutive reattach failures, then resets", async () => {
    const session = new FakeSession();
    const { schedule, calls, runNext } = fakeScheduler();
    const sup = attachSupplier(session, { schedule, backoff: { initialMs: 100, factor: 2 } });
    sup.serveShare(surface("ws.title", "value"), {});
    await flush();

    session.subscribeRejects = 2; // the next two reattach subscribes fail
    session.drop();
    const seen: number[] = [];

    seen.push(calls[0]!.ms); // 100  (attempt 0)
    runNext();
    await flush();
    seen.push(calls[0]!.ms); // 200  (attempt 1 — first failure)
    runNext();
    await flush();
    seen.push(calls[0]!.ms); // 400  (attempt 2 — second failure)
    runNext();
    await flush(); // this one succeeds (rejects exhausted) -> attempt resets

    expect(seen).toEqual([100, 200, 400]);
    expect(calls).toHaveLength(0); // no further reattach scheduled after success

    // a fresh drop starts back at the base delay (the backoff reset).
    session.drop();
    expect(calls[0]!.ms).toBe(100);
  });

  it("clean detach cancels a pending reattach and stops responding to drops", async () => {
    const session = new FakeSession();
    const { schedule, calls } = fakeScheduler();
    const sup = attachSupplier(session, { schedule });
    sup.serveExchange(surface("gwz.ops", "exchange"), () => ({ payload: utf8("ok") }));
    await flush();

    sup.detachAll();
    expect(session.hasReqHandler()).toBe(false); // hooks dropped
    session.drop(); // the drop signal is unsubscribed — nothing scheduled
    expect(calls).toHaveLength(0);
  });
});

// ---- attribution (Hello(principal), defensive) -----------------------------

describe("supplier — principal attribution (§4)", () => {
  it("says Hello with the principal once when the session supports it", async () => {
    const session = new FakeSession();
    const sup = attachSupplier(session, { principal: "gianni" });
    sup.serveExchange(surface("gwz.ops", "exchange"), () => ({ payload: utf8("ok") }));
    sup.serveShare(surface("ws.title", "value"), {});
    await flush();
    expect(session.helloCount).toBe(1); // once, not per-surface
    expect(session.helloPrincipal).toBe("gianni");
  });

  it("attaches fine against a session with no hello() (defensive optional)", async () => {
    // A minimal session lacking hello / onDrop — the parallel client-ts state.
    class NoHelloSession implements SupplierSession {
      origin = "s";
      subs = 0;
      subscribe(): Promise<void> {
        this.subs += 1;
        return Promise.resolve();
      }
      onExchangeReq(): () => void {
        return () => {};
      }
      respondExchange(): void {}
      append(share: string, gladeId: string, _s: string, payload: Uint8Array, key?: Uint8Array): SupplierOp {
        return { share, glade_id: gladeId, key: key ?? new Uint8Array(), origin: "s", seq: 1, payload };
      }
      onOps(): () => void {
        return () => {};
      }
    }
    const session = new NoHelloSession();
    const sup = attachSupplier(session, { principal: "gianni" });
    sup.serveShare(surface("ws.title", "value"), {});
    await flush();
    expect(session.subs).toBe(1); // attached without a hello method present
  });
});
