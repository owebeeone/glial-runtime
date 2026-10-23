import { describe, expect, it } from "vitest";
import { AssistanceSupplier, AssistanceConsumer, json, value, type Provider } from "../src/assistance/index.ts";

function fixture() {
  let now = 100, serial = 0, selected = "one", commits = 0;
  const identity = { application: "test", workspace: "w", supplier: "A", generation: "g1" };
  const provider: Provider = {
    capabilities: { version: "1", actions: { select: { type: "object" } } },
    read: () => ({ revision: "r1", sequence: commits, state: { selected } }),
    prepare: async (_action, args: any) => () => { selected = args.choice; commits++; },
  };
  const host = new AssistanceSupplier(identity, provider, { now: () => now, id: () => `token-${++serial}` });
  const consumer = new AssistanceConsumer(identity, "C", request => host.receive(request), () => now);
  const pair = async () => { host.setReady(true); host.enable(true); const offer = await consumer.offer(); host.accept(offer.token!); return consumer.status(offer.token!); };
  return { host, consumer, provider, identity, pair, now: (n: number) => { now = n; }, count: () => commits, selected: () => selected };
}
describe("assistance lifecycle and commit boundary", () => {
  it("defaults off, requires concrete readiness and explicit consent, reads fresh, dispatches once, ends", async () => {
    const f = fixture(); expect((await f.consumer.offer()).status).toBe("unavailable");
    f.host.enable(true); expect((await f.consumer.offer()).status).toBe("unavailable");
    const granted = await f.pair(); expect(granted.status).toBe("accepted");
    const before = value(await f.consumer.read()) as any;
    expect(before.state.selected).toBe("one");
    expect((await f.consumer.invoke("select", { choice: "two" }, before)).status).toBe("applied");
    expect(f.count()).toBe(1); expect((value(await f.consumer.read()) as any).state.selected).toBe("two");
    await f.consumer.end(); expect((await f.consumer.read()).status).toBe("ended");
    expect((await f.consumer.status(granted.token!)).status).toBe("ended");
  });
  it("fences a prepared mutation revoked before commit and never publishes private state", async () => {
    const f = fixture(); await f.pair(); let release!: () => void;
    f.provider.prepare = async () => { await new Promise<void>(r => { release = r; }); return () => { throw Error("must not commit"); }; };
    const pending = f.consumer.invoke("select", {}, value(await f.consumer.read()) as any);
    await Promise.resolve(); f.host.end("operator stopped"); release();
    expect((await pending).status).toBe("ended"); expect(f.count()).toBe(0);
  });
  it("checks expiry at use time and retains the first end reason", async () => {
    const f = fixture(); const grant = await f.pair(); f.now(Number(grant.expires) + 1);
    expect((await f.consumer.read()).status).toBe("ended");
    f.host.end("later"); expect((await f.consumer.status(grant.token!)).reason).toBe("expired");
  });
  it("refuses wrong supplier/generation, consumer, epoch, unsupported action and stale expected state", async () => {
    const f = fixture(); const grant = await f.pair();
    const base = { version: 1n, identity: f.identity, consumer: "C", operation: "read", deadline: 200n, token: grant.token, epoch: grant.epoch, payload: json({}) };
    for (const request of [{ ...base, identity: { ...f.identity, generation: "old" } }, { ...base, consumer: "other" }, { ...base, epoch: 999n }]) {
      expect((await f.host.receive(request)).status).toBe("refused");
    }
    expect((await f.consumer.invoke("missing", {}, { sequence: 0, revision: "r1" })).status).toBe("unsupported");
    expect((await f.consumer.invoke("select", {}, { sequence: 9, revision: "r1" })).status).toBe("conflict"); expect(f.count()).toBe(0);
  });
  it("cancel beats late accept; busy does not replace grant; disconnect requires fresh consent", async () => {
    const f = fixture(); f.host.enable(true); f.host.setReady(true);
    const offer = await f.consumer.offer(); await f.consumer.end(offer.token!); f.host.accept(offer.token!);
    expect((await f.consumer.status(offer.token!)).status).toBe("ended");
    await f.pair(); expect((await f.consumer.offer()).status).toBe("busy");
    f.host.setReady(false); f.host.setReady(true); expect((await f.consumer.read()).status).toBe("ended");
  });
  it("does not roll back committed work if reply is lost; unknown blocks automatic reissue", async () => {
    const f = fixture(); await f.pair(); let sent = 0;
    const c = new AssistanceConsumer(f.identity, "C", async request => { sent++; await f.host.receive(request); throw Error("lost reply"); }, () => 100);
    c.adopt(f.consumer.grant!);
    expect((await c.invoke("select", { choice: "two" }, { sequence: 0, revision: "r1" })).status).toBe("unknown");
    expect(f.selected()).toBe("two"); expect(f.count()).toBe(1);
    expect((await c.invoke("select", {}, { sequence: 1, revision: "r1" })).status).toBe("unknown"); expect(sent).toBe(1);
    c.abandon(); expect(f.count()).toBe(1);
  });
  it("discards an in-flight read result after local end even without remote confirmation", async () => {
    const f = fixture(); await f.pair(); let deliver!: (r: any) => void;
    const c = new AssistanceConsumer(f.identity, "C", request => request.operation === "end" ? Promise.reject(Error("offline")) : new Promise(r => { deliver = r; }), () => 100);
    c.adopt(f.consumer.grant!); const pending = c.read(); await c.end();
    deliver({ status: "observed", payload: json({ secret: "old" }) });
    expect((await pending).status).toBe("ended"); expect(c.grant).toBeUndefined();
  });
  it("cannot widen an accepted action set by mutating provider eligibility", async () => {
    const f = fixture(); await f.pair(); f.provider.capabilities.actions.erase = {};
    expect((await f.consumer.invoke("erase", {}, { revision: "r1", sequence: 0 })).status).toBe("unsupported");
    expect(f.count()).toBe(0);
  });
  it("consumer connection loss ends its handle and cannot restore consent on status", async () => {
    const f = fixture(); const grant = await f.pair(); f.consumer.disconnect();
    expect((await f.consumer.read()).status).toBe("ended");
    expect((await f.consumer.status(grant.token!)).reason).toBe("disconnected");
    expect(f.consumer.grant).toBeUndefined();
  });
});
