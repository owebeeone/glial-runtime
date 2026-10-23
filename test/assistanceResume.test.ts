import { expect, it } from "vitest";
import { AssistanceSupplier, AssistanceConsumer, value, type ResumeAuthority } from "../src/assistance/index";

it("resumes proven consumer into fresh generation without extending expiry or replaying unknown writes", async () => {
  let now = 1000, n = 0, saved: ResumeAuthority | undefined, commits = 0;
  const runtime = { now: () => now, id: () => `id-${++n}` };
  const identity = { application: "app", workspace: "launch", supplier: "tab", generation: "one" };
  const provider = { capabilities: { version: "1", actions: { write: {} } }, read: () => ({ revision: "r", sequence: 1 }), async prepare() { return () => { commits++; }; } };
  const options = () => ({ grantDurationMs: 28_800_000, resume: saved, saveResume: (r: ResumeAuthority | undefined) => { saved = r; } });
  const old = new AssistanceSupplier(identity, provider, runtime, options()); old.enable(true); old.setReady(true);
  const consumer = new AssistanceConsumer(identity, "agent", async r => { const out = await old.receive(r); if (r.operation === "invoke") throw Error("response lost"); return out; }, () => now);
  const offer = await consumer.offer(); old.accept(offer.token!); await consumer.status(offer.token!);
  const expires = consumer.grant!.expires; expect(saved?.consumer).toBe("agent");
  expect((await consumer.invoke("write", {}, { revision: "r", sequence: 1 })).status).toBe("unknown"); expect(commits).toBe(1);
  now += 1000;
  const nextIdentity = { ...identity, generation: "two" };
  const next = new AssistanceSupplier(nextIdentity, provider, runtime, options()); next.enable(true); next.setReady(true);
  expect((await consumer.resume(nextIdentity, r => next.receive(r))).status).toBe("accepted");
  expect(consumer.grant!.expires).toBe(expires); expect(consumer.identity.generation).toBe("two");
  expect((await consumer.invoke("write", {}, { revision: "r", sequence: 1 })).status).toBe("unknown"); expect(commits).toBe(1);
  expect((await next.receive({ version: 1n, identity, consumer: "agent", operation: "read", token: offer.token, epoch: 1n, deadline: BigInt(now + 1000), payload: new Uint8Array() })).status).toBe("refused");
  expect((await consumer.read()).status).toBe("observed");
  await consumer.end(); expect(saved).toBeUndefined();
  expect((await consumer.resume({ ...identity, generation: "three" }, r => next.receive(r))).status).toBe("refused");
});

it("does not resume unproved/wrong consumer, changed launch, expired or stopped authority", async () => {
  let now = 0, n = 0, saved: ResumeAuthority | undefined;
  const runtime = { now: () => now, id: () => `n-${++n}` }, identity = { application: "app", workspace: "launch", supplier: "tab", generation: "one" };
  const provider = { capabilities: { version: "1", actions: {} }, read: () => ({ revision: "r", sequence: 0 }), async prepare() { return () => {}; } };
  const host = new AssistanceSupplier(identity, provider, runtime, { saveResume: r => { saved = r; } }); host.enable(true); host.setReady(true);
  const agent = new AssistanceConsumer(identity, "agent", r => host.receive(r), () => now);
  const o = await agent.offer(); host.accept(o.token!); await agent.status(o.token!);
  expect((value(agent.grant!) as any).resume.secret).toBeTruthy();
  const nextId = { ...identity, generation: "two" }, next = new AssistanceSupplier(nextId, provider, runtime, { resume: saved }); next.enable(true); next.setReady(true);
  const stranger = new AssistanceConsumer(identity, "stranger", r => host.receive(r), () => now);
  stranger.adopt(agent.grant!);
  expect((await stranger.resume(nextId, r => next.receive(r))).status).toBe("refused");
  expect((await agent.resume({ ...nextId, workspace: "different-launch" }, r => next.receive(r))).status).toBe("refused");
  next.enable(false); expect((await agent.resume(nextId, r => next.receive(r))).status).toBe("refused");
  now = 999999; next.enable(true); expect((await agent.resume(nextId, r => next.receive(r))).status).toBe("refused");
});
