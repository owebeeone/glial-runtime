import type { AssistanceAdvertisement } from "@owebeeone/glade-decl/assistance";
import { AssistanceConsumer, value, result, type AssistanceResult } from "./index.ts";
import { callAssistance, type Client } from "./glade.ts";
const key = (a: AssistanceAdvertisement) => JSON.stringify(a.identity);
const serializable = (r: AssistanceResult) => {
  const payload = value(r);
  if (payload && typeof payload === "object") { delete (payload as any).resume; delete (payload as any).proof; }
  return { ...r, epoch: r.epoch === null ? null : Number(r.epoch), expires: r.expires === null ? null : Number(r.expires), payload };
};
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const tools = [
  { name: "listSessions", description: "List unexpired exact supplier routes; labels are descriptive only.", inputSchema: object({}) },
  { name: "requestPairing", description: "Request inline consent in one exact supplier.", inputSchema: object({ sessionKey: string }) },
  { name: "pairingStatus", description: "Read pairing status; accepted only after browser consent.", inputSchema: object({ token: string }) },
  { name: "readState", description: "Fresh granted state projection; not presentation evidence.", inputSchema: object({ token: string }) },
  { name: "invokeAction", description: "Invoke a granted action once. Unknown requires manual handling.", inputSchema: object({ token: string, action: string, arguments: { type: "object" }, expected: object({ sequence: { type: "integer" }, revision: string }) }) },
  { name: "writeValue", description: "Write one discovered writable scalar reference using its normal controller. Read fresh state first. Unknown requires manual handling.", inputSchema: object({ token: string, ref: string, value: { type: ["string", "number", "boolean", "null"] }, expected: object({ sequence: { type: "integer" }, revision: string }) }) },
  { name: "executeJavaScript", description: "Run synchronous JavaScript in the paired browser with the selected live GRIP value as grip. This has page privileges. Read fresh state first.", inputSchema: object({ token: string, context: string, gripKey: string, source: string, expected: object({ sequence: { type: "integer" }, revision: string }) }) },
  { name: "endPairing", description: "End locally immediately; report remote confirmation separately.", inputSchema: object({ token: string }) },
  { name: "abandonUnknown", description: "Manual continuation; does not establish cancellation or rollback.", inputSchema: object({ token: string }) },
];
/** Product-independent thin MCP façade. No subscriptions/resources advertised in v1 slice. */
export class AssistanceMcp {
  private ads = new Map<string, AssistanceAdvertisement>();
  private pairings = new Map<string, AssistanceConsumer>();
  private offDrop: () => void;
  constructor(private client: Client, private consumer: string, private now: () => number) {
    this.offDrop = client.onDrop(() => { for (const c of this.pairings.values()) { c.disconnect(); } this.ads.clear(); });
  }
  close() { this.offDrop(); for (const c of this.pairings.values()) { c.disconnect(); } this.ads.clear(); }
  advertisement(a: AssistanceAdvertisement) {
    if (a.version !== 1n || Number(a.expires) <= this.now()) { return; }
    for (const [k, old] of this.ads) { if (Number(old.expires) <= this.now()) { this.ads.delete(k); } }
    if (this.ads.size < 128 || this.ads.has(key(a))) { this.ads.set(key(a), a); }
  }
  list() { return [...this.ads.values()].filter(a => Number(a.expires) > this.now()).map(a => ({ sessionKey: key(a), identity: a.identity, label: a.label, capabilities: JSON.parse(new TextDecoder().decode(a.capabilities)), expires: Number(a.expires) })); }
  async call(name: string, args: any): Promise<any> {
    if (name === "listSessions") { return { sessions: this.list() }; }
    if (name === "requestPairing") {
      const a = this.ads.get(args.sessionKey);
      if (!a || Number(a.expires) <= this.now() || this.pairings.size >= 128) { return serializable(result("unavailable")); }
      const c = new AssistanceConsumer(a.identity, this.consumer, r => callAssistance(this.client, a.share, r), this.now);
      const offer = await c.offer(); if (offer.token) { this.pairings.set(offer.token, c); } return serializable(offer);
    }
    const c = this.pairings.get(args.token); if (!c) { return serializable(result("refused")); }
    if (name === "endPairing") { return serializable(await c.end(c.grant?.token ?? args.token)); }
    if (c.grant && name !== "abandonUnknown") {
      const candidatesOf = () => [...this.ads.values()].filter(a => Number(a.expires) > this.now() && a.identity.application === c.identity.application && a.identity.workspace === c.identity.workspace && a.identity.supplier === c.identity.supplier && a.identity.generation !== c.identity.generation);
      const fingerprint = (ads: AssistanceAdvertisement[]) => JSON.stringify(ads.map(ad => [key(ad), ad.share, Array.from(ad.capabilities)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      const candidates = candidatesOf(), initial = fingerprint(candidates);
      const signed: { ad: AssistanceAdvertisement; sequence: number }[] = [], legacy: AssistanceAdvertisement[] = [];
      for (const ad of candidates) {
        let capabilities: any;
        try { capabilities = JSON.parse(new TextDecoder().decode(ad.capabilities)); } catch { continue; }
        if (!Object.hasOwn(capabilities ?? {}, "resumeLineage")) {
          // A directory record can outlive its provider, including after a new
          // explicit pairing. Only a definitive absence makes it safe to ignore.
          const probe = await c.probeResume(ad.identity, r => callAssistance(this.client, ad.share, r));
          if (probe.status === "unknown") { return serializable(probe); }
          if (probe.status !== "unavailable") { legacy.push(ad); }
          continue;
        }
        if (await c.verifiesLineage(ad.identity, capabilities.resumeLineage)) { signed.push({ ad, sequence: capabilities.resumeLineage.sequence }); }
      }
      if (initial !== fingerprint(candidatesOf())) { return serializable(result("conflict", null, { reason: "assistance advertisements changed; read again" })); }
      const highest = signed.length ? Math.max(...signed.map(item => item.sequence)) : undefined;
      const proven = signed.filter(item => item.sequence === highest);
      if (proven.length > 1 || (!proven.length && legacy.length > 1)) {
        return serializable(result("refused", null, { reason: "ambiguous reload ownership; explicit pairing required" }));
      }
      let next = proven[0]?.ad ?? (legacy.length === 1 ? legacy[0] : undefined);
      if (signed.length > 1 && next) {
        const probes = await Promise.all(signed.map(async item => ({ ...item, result: await c.probeResume(item.ad.identity, r => callAssistance(this.client, item.ad.share, r)) })));
        if (probes.some(item => item.result.status === "unknown")) { return serializable(result("unknown", null, { reason: "resume candidate liveness is uncertain" })); }
        const available = probes.filter(item => item.result.status === "available");
        if (available.length > 1) { return serializable(result("refused", null, { reason: "ambiguous reload ownership; explicit pairing required" })); }
        next = available[0]?.ad;
        if (!next) { return serializable(result("refused", null, { reason: "no authenticated replacement available" })); }
      }
      if (next) {
        const current = await c.read();
        if (current.status === "observed") { return serializable(result("refused", null, { reason: "competing live supplier; explicit pairing required" })); }
        if (current.status === "unknown" && !/^no authority provider attached for /.test(current.reason ?? "")) { return serializable(current); }
      }
      if (next && initial !== fingerprint(candidatesOf())) { return serializable(result("conflict", null, { reason: "assistance advertisements changed; read again" })); }
      if (next && Number(next.expires) <= this.now()) { return serializable(result("expired", null, { reason: "replacement advertisement expired" })); }
      if (next) {
        const resumed = await c.resume(next.identity, r => callAssistance(this.client, next.share, r));
        if (resumed.status !== "accepted") { return serializable(resumed); }
        if (resumed.token) this.pairings.set(resumed.token, c);
        for (const [k, a] of this.ads) if (a.identity.supplier === next.identity.supplier && a.identity.workspace === next.identity.workspace && a.identity.application === next.identity.application && k !== key(next)) this.ads.delete(k);
      }
    }
    if (name === "pairingStatus") { return serializable(await c.status(c.grant?.token ?? args.token)); }
    if (name === "readState") { return serializable(await c.read()); }
    if (name === "invokeAction") { return serializable(await c.invoke(args.action, args.arguments, args.expected)); }
    if (name === "writeValue") { return serializable(await c.invoke("writeValue", { ref: args.ref, value: args.value }, args.expected)); }
    if (name === "executeJavaScript") { return serializable(await c.invoke("executeJavaScript", { context: args.context, gripKey: args.gripKey, source: args.source }, args.expected)); }
    if (name === "abandonUnknown") { c.abandon(); return { status: "manually-abandoned", cancelled: false }; }
    throw Error("Unknown tool");
  }
  async receive(message: any) {
    if (message.method?.startsWith("notifications/")) { return; }
    try {
      let response: unknown;
      if (message.method === "initialize") { response = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "glial-assistance-slice", version: "0.1.0" } }; }
      else if (message.method === "tools/list") { response = { tools }; }
      else if (message.method === "tools/call") {
        const out = await this.call(message.params.name, message.params.arguments ?? {});
        response = { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: ["refused", "invalid", "unsupported", "conflict", "unknown", "unavailable", "busy", "expired"].includes(out.status) };
      } else { return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported method" } }; }
      return { jsonrpc: "2.0", id: message.id, result: response };
    } catch (error) { return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: error instanceof Error ? error.message : "Invalid request" } }; }
  }
}
