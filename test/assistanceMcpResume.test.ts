import { expect, it } from "vitest";
import { assistanceIR, loadSchema, encode, decode } from "@owebeeone/glade-decl/assistance";
import { AssistanceSupplier, json, type ResumeAuthority } from "../src/assistance/index";
import { AssistanceMcp } from "../src/assistance/mcp";

it("MCP resumes only verified same supplier and hides retained credentials from its tool results", async () => {
  const schema = loadSchema(assistanceIR); let saved: ResumeAuthority | undefined, n = 0;
  const identity = { application: "a", workspace: "w", supplier: "tab", generation: "one" };
  const provider = { capabilities: { version: "1", actions: {} }, read: () => ({ revision: "r", sequence: 0 }), async prepare() { return () => {}; } };
  const options = () => ({ resume: saved, saveResume: (v: ResumeAuthority | undefined) => { saved = v; } });
  const runtime = { now: () => 100, id: () => `id-${++n}` };
  const hosts = new Map<string, AssistanceSupplier>();
  const a = new AssistanceSupplier(identity, provider, runtime, options()); a.enable(true); a.setReady(true); hosts.set("route-one", a);
  const client: any = { onDrop: () => () => {}, exchange: async (share: string, _id: string, bytes: Uint8Array) => {
    const host = hosts.get(share);
    return host ? { ok: true, payload: encode(schema, "AssistanceResult", await host.receive(decode(schema, "AssistanceRequest", bytes))) } : { ok: false, error: "no authority provider attached for fixture" };
  } };
  const mcp = new AssistanceMcp(client, "agent", () => 100);
  const advertise = (generation: string) => mcp.advertisement({ version: 1n, identity: { ...identity, generation }, share: `route-${generation}`, label: "Tab", capabilities: json({}), expires: 10000n });
  advertise("one"); const offer = await mcp.call("requestPairing", { sessionKey: JSON.stringify(identity) }); a.accept(offer.token);
  const accepted = await mcp.call("pairingStatus", { token: offer.token }); expect(accepted.status).toBe("accepted");
  expect(JSON.stringify(accepted)).not.toContain(saved!.secret); expect(accepted.payload.resume).toBeUndefined();
  hosts.delete("route-one");
  const b = new AssistanceSupplier({ ...identity, generation: "two" }, provider, runtime, options()); b.enable(true); b.setReady(true); hosts.set("route-two", b); advertise("two");
  const read = await mcp.call("readState", { token: offer.token }); expect(read.status).toBe("observed"); expect(b.isPaired()).toBe(true);
  await mcp.call("endPairing", { token: offer.token }); expect(saved).toBeUndefined();
});

it("selects an authenticated reload lineage without trusting advertisement order", async () => {
  const schema = loadSchema(assistanceIR); let saved: ResumeAuthority | undefined, n = 0;
  const identity = { application: "a", workspace: "w", supplier: "tab", generation: "one" };
  const provider = { capabilities: { version: "1", actions: {} }, read: () => ({ revision: "r", sequence: 0 }), async prepare() { return () => {}; } };
  const runtime = { now: () => 100, id: () => `id-${++n}` };
  const hosts = new Map<string, AssistanceSupplier>();
  const first = new AssistanceSupplier(identity, provider, runtime, { saveResume: r => { saved = r; } }); first.enable(true); first.setReady(true); hosts.set("one", first);
  const client: any = { onDrop: () => () => {}, exchange: async (share: string, _id: string, bytes: Uint8Array) => {
    const host = hosts.get(share);
    return host ? { ok: true, payload: encode(schema, "AssistanceResult", await host.receive(decode(schema, "AssistanceRequest", bytes))) } : { ok: false, error: "no authority provider attached for fixture" };
  } };
  const mcp = new AssistanceMcp(client, "agent", () => 100);
  const ad = async (generation: string, sequence: number, authority = saved!) => {
    const next = { ...identity, generation };
    const { signResumeLineage } = await import("../src/assistance/index");
    mcp.advertisement({ version: 1n, identity: next, share: generation, label: "Tab", capabilities: json({ resumeLineage: await signResumeLineage(authority, next, sequence) }), expires: 10000n });
  };
  mcp.advertisement({ version: 1n, identity, share: "one", label: "Tab", capabilities: json({}), expires: 10000n });
  const offer = await mcp.call("requestPairing", { sessionKey: JSON.stringify(identity) }); first.accept(offer.token);
  const accepted = await mcp.call("pairingStatus", { token: offer.token }); const expiry = accepted.expires;
  hosts.delete("one");
  const oldAuthority = saved!;
  const nextId = { ...identity, generation: "three" };
  const current = new AssistanceSupplier(nextId, provider, runtime, { resume: oldAuthority, saveResume: r => { saved = r; } }); current.enable(true); current.setReady(true); hosts.set("three", current);
  await ad("three", 3); await ad("two", 2); await ad("forged", 99, { ...oldAuthority, secret: "wrong" });
  const read = await mcp.call("readState", { token: offer.token });
  expect(read.status).toBe("observed"); expect(current.isPaired()).toBe(true);
  expect((await mcp.call("pairingStatus", { token: offer.token })).expires).toBe(expiry);
  expect((await mcp.call("endPairing", { token: offer.token })).status).toBe("ended");
  expect(saved).toBeUndefined();
});

async function lineageFixture() {
  const schema = loadSchema(assistanceIR); let saved: ResumeAuthority | undefined, n = 0;
  const identity = { application: "a", workspace: "w", supplier: "tab", generation: "one" };
  const provider = { capabilities: { version: "1", actions: { write: {} } }, read: () => ({ revision: "r", sequence: 0 }), async prepare() { return () => {}; } };
  const runtime = { now: () => 100, id: () => `id-${++n}` };
  const hosts = new Map<string, AssistanceSupplier>();
  const absent = new Set<string>(["one"]);
  const calls: { share: string; operation: string }[] = [];
  const first = new AssistanceSupplier(identity, provider, runtime, { saveResume: r => { saved = r; } }); first.enable(true); first.setReady(true); hosts.set("one", first);
  const client: any = { onDrop: () => () => {}, exchange: async (share: string, _id: string, bytes: Uint8Array) => {
    const request = decode(schema, "AssistanceRequest", bytes); calls.push({ share, operation: request.operation });
    const host = hosts.get(share);
    return host ? { ok: true, payload: encode(schema, "AssistanceResult", await host.receive(request)) } : { ok: false, error: absent.has(share) ? "no authority provider attached for fixture" : "outcome unknown" };
  } };
  const mcp = new AssistanceMcp(client, "agent", () => 100);
  mcp.advertisement({ version: 1n, identity, share: "one", label: "Tab", capabilities: json({}), expires: 10000n });
  const offer = await mcp.call("requestPairing", { sessionKey: JSON.stringify(identity) }); first.accept(offer.token);
  await mcp.call("pairingStatus", { token: offer.token });
  hosts.delete("one");
  const authority = saved!;
  const ad = async (generation: string, sequence: number, live = false) => {
    const next = { ...identity, generation };
    if (live) {
      const host = new AssistanceSupplier(next, provider, runtime, { resume: authority, saveResume: r => { saved = r; } });
      host.enable(true); host.setReady(true); hosts.set(generation, host);
    }
    const { signResumeLineage } = await import("../src/assistance/index");
    mcp.advertisement({ version: 1n, identity: next, share: generation, label: "Tab", capabilities: json({ resumeLineage: await signResumeLineage(authority, next, sequence) }), expires: 10000n });
  };
  return { mcp, token: offer.token, ad, calls, hosts, absent, first, saved: () => saved };
}

it("refuses equally ranked proven competing generations without resuming either", async () => {
  const f = await lineageFixture(); await f.ad("two", 2, true); await f.ad("three", 2, true);
  const outcome = await f.mcp.call("readState", { token: f.token });
  expect(outcome.status).toBe("refused"); expect(outcome.reason).toContain("ambiguous");
  expect(f.calls.filter(call => call.operation === "resume")).toHaveLength(0);
  expect(f.hosts.get("two")!.isPaired()).toBe(false); expect(f.hosts.get("three")!.isPaired()).toBe(false);
});

it("keeps an uncertain resume uncertain and never falls back to an older candidate", async () => {
  const f = await lineageFixture(); await f.ad("two", 2, true); await f.ad("three", 3);
  const outcome = await f.mcp.call("readState", { token: f.token });
  expect(outcome.status).toBe("unknown");
  expect(f.calls.filter(call => call.operation === "resume")).toHaveLength(0);
  expect(f.hosts.get("two")!.isPaired()).toBe(false);
  expect((await f.mcp.call("readState", { token: f.token })).status).toBe("unknown");
  expect(f.calls.filter(call => call.operation === "resume")).toHaveLength(0);
});

it("refuses two simultaneously live proven generations even with different counters", async () => {
  const f = await lineageFixture(); await f.ad("two", 2, true); await f.ad("three", 3, true);
  const outcome = await f.mcp.call("readState", { token: f.token });
  expect(outcome.status).toBe("refused"); expect(outcome.reason).toContain("ambiguous");
  expect(f.calls.filter(call => call.operation === "resume")).toHaveLength(0);
});

it("refuses a proven replacement while the original supplier is still live", async () => {
  const f = await lineageFixture(); f.hosts.set("one", f.first); await f.ad("two", 2, true);
  const outcome = await f.mcp.call("readState", { token: f.token });
  expect(outcome.status).toBe("refused"); expect(outcome.reason).toContain("competing live supplier");
  expect(f.calls.filter(call => call.operation === "resume")).toHaveLength(0);
});

it("does not resume after Stop sharing clears the replacement authority", async () => {
  const f = await lineageFixture(); await f.ad("two", 2, true); await f.ad("three", 3, true);
  f.hosts.delete("two");
  f.absent.add("two");
  f.hosts.get("three")!.enable(false);
  const outcome = await f.mcp.call("readState", { token: f.token });
  expect(outcome.status).toBe("refused"); expect(f.saved()).toBeUndefined();
  expect(f.hosts.get("three")!.isPaired()).toBe(false);
});

it.each([
  { route: "absent", status: "observed" },
  { route: "uncertain", status: "unknown" },
  { route: "live", status: "refused" },
])("handles an older $route route after Stop sharing and fresh pairing", async ({ route, status }) => {
  const schema = loadSchema(assistanceIR); let n = 0;
  const identity = { application: "a", workspace: "w", supplier: "tab", generation: "old" };
  const provider = { capabilities: { version: "1", actions: {} }, read: () => ({ revision: "fresh", sequence: 1 }), async prepare() { return () => {}; } };
  const runtime = { now: () => 100, id: () => `fresh-${++n}` };
  const hosts = new Map<string, AssistanceSupplier>();
  const client: any = { onDrop: () => () => {}, exchange: async (share: string, _id: string, bytes: Uint8Array) => {
    const host = hosts.get(share);
    return host ? { ok: true, payload: encode(schema, "AssistanceResult", await host.receive(decode(schema, "AssistanceRequest", bytes))) } : { ok: false, error: route === "uncertain" ? "transport outcome unknown" : "no authority provider attached for fixture" };
  } };
  const mcp = new AssistanceMcp(client, "agent", () => 100);
  const old = new AssistanceSupplier(identity, provider, runtime, { saveResume: () => {} }); old.enable(true); old.setReady(true); hosts.set("old", old);
  const advertise = (generation: string) => mcp.advertisement({ version: 1n, identity: { ...identity, generation }, share: generation, label: "Tab", capabilities: json({}), expires: 10000n });
  advertise("old");
  const first = await mcp.call("requestPairing", { sessionKey: JSON.stringify(identity) }); old.accept(first.token);
  expect((await mcp.call("pairingStatus", { token: first.token })).status).toBe("accepted");
  old.enable(false); hosts.delete("old");
  if (route === "live") { old.enable(true); hosts.set("old", old); }
  const next = { ...identity, generation: "new" };
  const fresh = new AssistanceSupplier(next, provider, runtime, { saveResume: () => {} }); fresh.enable(true); fresh.setReady(true); hosts.set("new", fresh); advertise("new");
  const second = await mcp.call("requestPairing", { sessionKey: JSON.stringify(next) }); fresh.accept(second.token);
  expect((await mcp.call("pairingStatus", { token: second.token })).status).toBe("accepted");
  expect((await mcp.call("readState", { token: second.token })).status).toBe(status);
  expect((await mcp.call("readState", { token: first.token })).status).not.toBe("observed");
});
