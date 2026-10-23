import { describe, expect, it } from "vitest";
import {
  Supplier,
  type ExchangeReply,
  type ExchangeRequest,
  type ScheduleFn,
  type ShareController,
  type SupplierOp,
  type SupplierSession,
  type SupplierSurface,
} from "../src/supplier/index.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Subscription = ReturnType<typeof deferred>;

// Fan-out matches SupplierSession's multi-surface contract. Subscription gates
// let the test choose the exact stop/drop/ack schedule without wall-clock waits.
class ControlledSession implements SupplierSession {
  readonly origin = "supplier";
  readonly requests = new Set<(request: ExchangeRequest) => void>();
  readonly operations = new Set<(ops: SupplierOp[]) => void>();
  readonly drops = new Set<() => void>();
  readonly published: SupplierOp[] = [];
  private queued: Subscription[] = [];
  private waiting: ((subscription: Subscription) => void)[] = [];

  subscribe() {
    const subscription = deferred();
    const waiter = this.waiting.shift();
    if (waiter) { waiter(subscription); }
    else { this.queued.push(subscription); }
    return subscription.promise;
  }
  nextSubscription(): Promise<Subscription> {
    const next = this.queued.shift();
    return next ? Promise.resolve(next) : new Promise((resolve) => { this.waiting.push(resolve); });
  }
  onExchangeReq(handler: (request: ExchangeRequest) => void) {
    this.requests.add(handler);
    return () => { this.requests.delete(handler); };
  }
  respondExchange(_reply: ExchangeReply) {}
  onOps(handler: (ops: SupplierOp[]) => void) {
    this.operations.add(handler);
    return () => { this.operations.delete(handler); };
  }
  append(share: string, gladeId: string, _shape: string, payload: Uint8Array, key = new Uint8Array()) {
    const op = { share, glade_id: gladeId, key, payload, origin: this.origin, seq: this.published.length + 1 };
    this.published.push(op);
    return op;
  }
  onDrop(handler: () => void) {
    this.drops.add(handler);
    return () => { this.drops.delete(handler); };
  }
  drop() {
    this.requests.clear();
    this.operations.clear();
    for (const handler of this.drops) { handler(); }
  }
}

function scheduler() {
  const pending = new Set<() => void>();
  const schedule: ScheduleFn = (fn) => {
    pending.add(fn);
    return () => { pending.delete(fn); };
  };
  return {
    pending,
    schedule,
    runNext() {
      const next = pending.values().next().value;
      if (!next) { throw Error("No scheduled reattach"); }
      pending.delete(next);
      next();
    },
  };
}

// Drain the subscribe -> attach -> attachOne/reattachAll promise continuations.
// Unlike a sleep, resolution/rejection itself controls when the race proceeds.
async function settle(subscription: Subscription, fail = false) {
  if (fail) { subscription.reject(Error("subscription failed")); }
  else { subscription.resolve(); }
  await subscription.promise.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
}

const surface = (shape: "exchange" | "value" | "log", id = "test"): SupplierSurface => ({
  share: "test-share", glade_id: { id }, shape,
});

describe.each(["exchange", "value", "log"] as const)("supplier lifecycle — %s", (shape) => {
  function serve(supplier: Supplier, onServe: (controller: ShareController) => void) {
    return shape === "exchange"
      ? supplier.serveExchange(surface(shape), () => ({ payload: new Uint8Array() }))
      : supplier.serveShare(surface(shape), { onServe });
  }

  it.each(["serving", "supplier"] as const)("does not revive after %s detaches during subscribe", async (scope) => {
    const session = new ControlledSession(), clock = scheduler();
    const supplier = new Supplier(session, { schedule: clock.schedule });
    let served = 0;
    const serving = serve(supplier, () => { served++; });
    const pending = await session.nextSubscription();
    if (scope === "serving") { serving.detach(); }
    else { supplier.detachAll(); }
    await settle(pending);
    expect(session.requests.size + session.operations.size).toBe(0);
    expect(served).toBe(0);
    expect(clock.pending.size).toBe(0);
    supplier.detachAll();
  });

  it("does not revive when detached during an already-started reattach", async () => {
    const session = new ControlledSession(), clock = scheduler();
    const supplier = new Supplier(session, { schedule: clock.schedule });
    let served = 0;
    const serving = serve(supplier, () => { served++; });
    await settle(await session.nextSubscription());
    session.drop();
    clock.runNext();
    const reconnect = await session.nextSubscription();
    serving.detach();
    await settle(reconnect);
    expect(session.requests.size + session.operations.size).toBe(0);
    expect(served).toBe(shape === "exchange" ? 0 : 1);
    expect(clock.pending.size).toBe(0);
    supplier.detachAll();
  });

  it("ignores an older attach acknowledgement after a newer connection attached", async () => {
    const session = new ControlledSession(), clock = scheduler();
    const supplier = new Supplier(session, { schedule: clock.schedule });
    let served = 0;
    serve(supplier, () => { served++; });
    const old = await session.nextSubscription();
    session.drop();
    clock.runNext();
    const current = await session.nextSubscription();
    await settle(current);
    await settle(old);
    expect(session.requests.size + session.operations.size).toBe(1);
    expect(served).toBe(shape === "exchange" ? 0 : 1);
    supplier.detachAll();
    expect(session.requests.size + session.operations.size).toBe(0);
  });

  it("does not schedule retries when a detached subscription later fails", async () => {
    const session = new ControlledSession(), clock = scheduler();
    const supplier = new Supplier(session, { schedule: clock.schedule });
    const serving = serve(supplier, () => {});
    const pending = await session.nextSubscription();
    serving.detach();
    await settle(pending, true);
    expect(clock.pending.size).toBe(0);
    supplier.detachAll();
  });
});

it.each(["value", "log"] as const)("invalidates a detached %s publisher without disturbing another serving", async (shape) => {
  const session = new ControlledSession(), supplier = new Supplier(session);
  let stopped!: ShareController, active!: ShareController;
  const serving = supplier.serveShare(surface(shape, "stopped"), { onServe: (controller) => { stopped = controller; } });
  await settle(await session.nextSubscription());
  supplier.serveShare(surface(shape, "active"), { onServe: (controller) => { active = controller; } });
  await settle(await session.nextSubscription());
  serving.detach();
  const publish = (controller: ShareController) => shape === "value"
    ? controller.set(new Uint8Array([1])) : controller.append(new Uint8Array([1]));
  expect(() => publish(stopped)).toThrow(/detach/i);
  expect(session.published).toHaveLength(0);
  publish(active);
  expect(session.published.map((op) => op.glade_id)).toEqual(["active"]);
  expect(session.operations.size).toBe(1);
  supplier.detachAll();
  expect(() => publish(active)).toThrow(/detach/i);
  expect(session.operations.size).toBe(0);
});
