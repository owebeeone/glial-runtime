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
  const client: any = { onDrop: () => () => {}, exchange: async (share: string, _id: string, bytes: Uint8Array) => ({ ok: true, payload: encode(schema, "AssistanceResult", await hosts.get(share)!.receive(decode(schema, "AssistanceRequest", bytes))) }) };
  const mcp = new AssistanceMcp(client, "agent", () => 100);
  const advertise = (generation: string) => mcp.advertisement({ version: 1n, identity: { ...identity, generation }, share: `route-${generation}`, label: "Tab", capabilities: json({}), expires: 10000n });
  advertise("one"); const offer = await mcp.call("requestPairing", { sessionKey: JSON.stringify(identity) }); a.accept(offer.token);
  const accepted = await mcp.call("pairingStatus", { token: offer.token }); expect(accepted.status).toBe("accepted");
  expect(JSON.stringify(accepted)).not.toContain(saved!.secret); expect(accepted.payload.resume).toBeUndefined();
  const b = new AssistanceSupplier({ ...identity, generation: "two" }, provider, runtime, options()); b.enable(true); b.setReady(true); hosts.set("route-two", b); advertise("two");
  const read = await mcp.call("readState", { token: offer.token }); expect(read.status).toBe("observed"); expect(b.isPaired()).toBe(true);
  await mcp.call("endPairing", { token: offer.token }); expect(saved).toBeUndefined();
});
