/** Optional assistance integration. No GRIP, React, product, or transport core policy. */
import type { AssistanceIdentity, AssistanceRequest, AssistanceResult } from "@owebeeone/glade-decl/assistance";
export type { AssistanceIdentity, AssistanceRequest, AssistanceResult } from "@owebeeone/glade-decl/assistance";
export const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export const value = (r: AssistanceResult): unknown => JSON.parse(new TextDecoder().decode(r.payload));
export interface Observation { revision: string; sequence: number; state?: unknown; }
export interface ProviderAccess { token: string; epoch: bigint }
export interface Provider {
  capabilities: { version: string; actions: Record<string, unknown> };
  /** Synchronous projection. Apply configured exclusions before reading values. */
  read(access?: ProviderAccess): Observation;
  /** Preparation MUST NOT mutate. Returned commit MUST be synchronous. */
  prepare(action: string, args: unknown, access?: ProviderAccess): Promise<() => void>;
}
export interface Runtime { now(): number; id(): string; changed?(): void; }
/** Local-only retained authority. Never put this in discovery or application state. */
export interface ResumeAuthority { application: string; workspace: string; supplier: string; consumer: string; expires: number; scope: string; secret: string }
export interface AssistanceOptions { grantDurationMs?: number; resumeScope?: string; resume?: ResumeAuthority; saveResume?(authority: ResumeAuthority | undefined): void }
async function proof(secret: string, direction: string, identity: AssistanceIdentity, consumer: string, nonce: string) {
  const key = await crypto.subtle.importKey("raw", json(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, json([direction, identity.application, identity.workspace, identity.supplier, identity.generation, consumer, nonce]));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
type Offer = { token: string; consumer: string; deadline: number; epoch: bigint; status: string; reason: string | null };
export function result(status: string, payload: unknown = null, extra: Partial<AssistanceResult> = {}): AssistanceResult {
  return { status, token: null, epoch: null, expires: null, reason: null, payload: json(payload), ...extra };
}
export function sameIdentity(a: AssistanceIdentity, b: AssistanceIdentity) {
  return a.application === b.application && a.workspace === b.workspace && a.supplier === b.supplier && a.generation === b.generation;
}

export class AssistanceSupplier {
  private enabled = false;
  private ready = false;
  private epoch = 0n;
  private active?: Offer;
  private offers = new Map<string, Offer>();
  private committing = false;
  private capabilities: Provider["capabilities"];
  private resumeScope: string;
  private resumeAuthority?: ResumeAuthority;
  private resuming = false;
  constructor(readonly identity: AssistanceIdentity, private provider: Provider, private runtime: Runtime, private options: AssistanceOptions = {}) {
    this.capabilities = structuredClone(provider.capabilities);
    this.resumeScope = JSON.stringify([this.capabilities, options.resumeScope ?? ""]);
    const r = options.resume;
    if (r && r.application === identity.application && r.workspace === identity.workspace && r.supplier === identity.supplier && r.scope === this.resumeScope && r.expires > runtime.now()) this.resumeAuthority = structuredClone(r);
  }
  enable(enabled: boolean) { this.enabled = enabled; if (!enabled) { this.end("disabled"); } this.changed(); }
  setReady(ready: boolean) { this.ready = ready; if (!ready) { this.end("disconnected"); } this.changed(); }
  private changed() { this.runtime.changed?.(); }
  pending() { this.expire(); return [...this.offers.values()].filter(o => o.status === "pending").map(o => ({ token: o.token, consumer: o.consumer })); }
  isPaired() { this.expire(); return !!this.active; }
  private finish(o: Offer, reason: string) {
    if (o.status !== "ended") { o.status = "ended"; o.reason = reason; if (this.active === o) { this.active = undefined; this.saveResume(undefined); } this.changed(); }
  }
  private expire() { for (const o of this.offers.values()) { if (o.status !== "ended" && this.runtime.now() >= o.deadline) { this.finish(o, "expired"); } } }
  end(reason = "operator stopped") { for (const o of this.offers.values()) { this.finish(o, reason); } this.saveResume(undefined); }
  private saveResume(authority: ResumeAuthority | undefined) { this.resumeAuthority = authority; this.options.saveResume?.(authority ? structuredClone(authority) : undefined); }
  private remember(o: Offer) {
    if (this.options.saveResume) this.saveResume({ application: this.identity.application, workspace: this.identity.workspace, supplier: this.identity.supplier, consumer: o.consumer, expires: o.deadline, scope: this.resumeScope, secret: crypto.randomUUID() + crypto.randomUUID() });
  }
  decline(token: string) { const o = this.offers.get(token); if (o) { this.finish(o, "declined"); } }
  accept(token: string) {
    this.expire(); const o = this.offers.get(token);
    if (!o || o.status !== "pending" || !this.enabled || !this.ready || this.active) { return; }
    o.status = "accepted"; o.epoch = ++this.epoch; o.deadline = this.runtime.now() + (this.options.grantDurationMs ?? 300_000); this.active = o; this.remember(o);
    for (const other of this.offers.values()) { if (other !== o && other.status === "pending") { this.finish(other, "busy"); } }
    this.changed();
  }
  private status(o: Offer) {
    return o.status === "ended" ? result("ended", null, { token: o.token, reason: o.reason })
      : result(o.status, { capabilities: this.capabilities, ...(o === this.active && this.resumeAuthority ? { resume: this.resumeAuthority } : {}) }, { token: o.token, epoch: o.epoch, expires: BigInt(o.deadline) });
  }
  private permitted(o: Offer, r: AssistanceRequest) {
    this.expire(); return this.enabled && this.ready && this.active === o && o.status === "accepted" && o.epoch === r.epoch && this.runtime.now() < Number(r.deadline);
  }
  async receive(r: AssistanceRequest): Promise<AssistanceResult> {
    this.expire();
    if (r.version !== 1n || !sameIdentity(r.identity, this.identity) || !r.consumer) { return result("refused", null, { reason: "identity or version mismatch" }); }
    if (this.runtime.now() >= Number(r.deadline)) { return result("expired"); }
    if (r.operation === "resume") {
      const authority = this.resumeAuthority;
      if (!this.enabled || !this.ready || this.active || this.resuming || !authority || authority.consumer !== r.consumer || authority.expires <= this.runtime.now()) return result("refused");
      this.resuming = true;
      try {
        const input = JSON.parse(new TextDecoder().decode(r.payload));
        if (typeof input?.nonce !== "string" || input.nonce.length > 128 || input.proof !== await proof(authority.secret, "request", this.identity, r.consumer, input.nonce)) return result("refused");
        const responseProof = await proof(authority.secret, "response", this.identity, r.consumer, input.nonce);
        // Permission may have changed while WebCrypto was running.
        if (!this.enabled || !this.ready || this.resumeAuthority !== authority || authority.expires <= this.runtime.now() || this.runtime.now() >= Number(r.deadline)) return result("refused");
        const o: Offer = { token: this.runtime.id(), consumer: r.consumer, deadline: authority.expires, epoch: ++this.epoch, status: "accepted", reason: null };
        this.offers.set(o.token, o); this.active = o; this.remember(o); this.changed();
        const out = this.status(o); out.payload = json({ ...(value(out) as object), proof: responseProof }); return out;
      } catch { return result("refused"); } finally { this.resuming = false; }
    }
    if (r.operation === "offer") {
      if (!this.enabled || !this.ready) { return result("unavailable"); }
      if (this.active) { return result("busy"); }
      // Bound retained ended statuses without evicting and reviving any token.
      if (this.offers.size >= 128) { return result("unavailable", null, { reason: "pairing capacity reached; restart supplier with fresh generation" }); }
      const token = this.runtime.id(), o: Offer = { token, consumer: r.consumer, deadline: Math.min(Number(r.deadline), this.runtime.now() + 60_000), epoch: 0n, status: "pending", reason: null };
      this.offers.set(token, o); this.changed(); return this.status(o);
    }
    const o = this.offers.get(r.token ?? "");
    if (!o || o.consumer !== r.consumer) { return result("refused"); }
    if (r.operation === "end") { this.finish(o, "consumer ended"); return this.status(o); }
    if (r.operation === "status" || o.status === "ended") { return this.status(o); }
    if (!this.permitted(o, r)) { return result("refused"); }
    const access = { token: o.token, epoch: o.epoch };
    if (r.operation === "read") { return result("observed", this.provider.read(access)); }
    if (r.operation !== "invoke") { return result("unsupported"); }
    if (this.committing) { return result("busy"); }
    let input: { action: string; args: unknown; expected: Observation };
    try { input = JSON.parse(new TextDecoder().decode(r.payload)); } catch { return result("invalid"); }
    if (!input || typeof input.action !== "string" || !Object.hasOwn(this.capabilities.actions, input.action)) { return result("unsupported"); }
    const current = () => { const state = this.provider.read(access); return input.expected && state.sequence === input.expected.sequence && state.revision === input.expected.revision; };
    if (!current()) { return result("conflict"); }
    this.committing = true;
    try {
      let commit: () => void;
      try { commit = await this.provider.prepare(input.action, input.args, access); }
      catch (error) { return result("invalid", null, { reason: error instanceof Error ? error.message : "invalid action" }); }
      if (!this.permitted(o, r)) { return o.status === "ended" ? this.status(o) : result("expired"); }
      if (!current()) { return result("conflict"); }
      // No await between the final authorization check and the application commit.
      commit(); return result("applied");
    } catch (error) {
      // A throwing application commit may have taken effect. Never label it rejected.
      return result("unknown", null, { reason: error instanceof Error ? error.message : "application outcome unknown" });
    } finally { this.committing = false; }
  }
}

export class AssistanceConsumer {
  grant?: AssistanceResult;
  private ended = new Map<string, AssistanceResult>();
  private unresolved = false;
  private disconnected = false;
  private resuming = false;
  constructor(public identity: AssistanceIdentity, readonly consumer: string, private call: (r: AssistanceRequest) => Promise<AssistanceResult>, private now: () => number) {}
  private attemptedResumes = new Set<string>();
  async resume(identity: AssistanceIdentity, call: (r: AssistanceRequest) => Promise<AssistanceResult>) {
    const r = this.grant && (value(this.grant) as { resume?: ResumeAuthority }).resume;
    if (this.disconnected || this.resuming || this.attemptedResumes.has(identity.generation) || !r || r.consumer !== this.consumer || r.expires <= this.now() || r.application !== identity.application || r.workspace !== identity.workspace || r.supplier !== identity.supplier || identity.generation === this.identity.generation) return result("refused");
    this.attemptedResumes.add(identity.generation);
    this.resuming = true;
    const original = this.grant;
    try {
      const nonce = crypto.randomUUID(), signature = await proof(r.secret, "request", identity, this.consumer, nonce);
      const out = await call({ version: 1n, identity, consumer: this.consumer, operation: "resume", deadline: BigInt(this.now() + 10_000), token: null, epoch: null, payload: json({ nonce, proof: signature }) });
      if (out.status !== "accepted" || !out.token || out.expires !== original?.expires || (value(out) as any).proof !== await proof(r.secret, "response", identity, this.consumer, nonce)) return result("refused");
      if (this.disconnected || this.grant !== original) return result("refused");
      this.identity = identity; this.call = call; this.adopt(out); return out;
    } catch { return result("unknown", null, { reason: "resume outcome unknown; explicit pairing required" }); }
    finally { this.resuming = false; }
  }
  adopt(grant: AssistanceResult) { if (grant.status === "accepted" && grant.token && !this.ended.has(grant.token)) { this.grant = grant; } }
  private async request(operation: string, payload: unknown = null, token = this.grant?.token ?? null) {
    if (token && this.ended.has(token)) { return this.ended.get(token)!; }
    if (this.disconnected) { return result("ended", { remoteConfirmed: false }, { token, reason: "disconnected" }); }
    try {
      const out = await this.call({ version: 1n, identity: this.identity, consumer: this.consumer, operation, deadline: BigInt(this.now() + (operation === "offer" ? 60_000 : 10_000)), token, epoch: this.grant?.epoch ?? null, payload: json(payload) });
      if (token && this.ended.has(token)) { return this.ended.get(token)!; }
      if (this.disconnected) { return result("ended", { remoteConfirmed: false }, { token, reason: "disconnected" }); }
      if (out.status === "ended" && token) { this.ended.set(token, out); this.grant = undefined; }
      return out;
    } catch { return result("unknown", null, { reason: "transport outcome unknown; manual handling required" }); }
  }
  offer() { return this.request("offer"); }
  async status(token: string) { const out = await this.request("status", null, token); this.adopt(out); return out; }
  read() { return this.grant ? this.request("read") : Promise.resolve(result("ended")); }
  async invoke(action: string, args: unknown, expected: Observation) {
    if (!this.grant) { return result("ended"); }
    if (this.unresolved) { return result("unknown", null, { reason: "previous action unresolved; manually abandon or end pairing" }); }
    this.unresolved = true;
    const out = await this.request("invoke", { action, args, expected: { sequence: expected.sequence, revision: expected.revision } });
    if (out.status !== "unknown") { this.unresolved = false; } return out;
  }
  abandon() { this.unresolved = false; }
  disconnect() {
    this.disconnected = true;
    if (this.grant?.token) { this.ended.set(this.grant.token, result("ended", { remoteConfirmed: false }, { token: this.grant.token, reason: "disconnected" })); }
    this.grant = undefined; this.unresolved = false;
  }
  async end(token = this.grant?.token ?? "") {
    if (this.ended.has(token)) { return this.ended.get(token)!; }
    const epoch = this.grant?.epoch ?? null;
    const ended = result("ended", { remoteConfirmed: false }, { token, reason: "consumer ended" });
    this.ended.set(token, ended); this.grant = undefined; this.unresolved = false;
    try {
      const remote = await this.call({ version: 1n, identity: this.identity, consumer: this.consumer, operation: "end", deadline: BigInt(this.now() + 10_000), token, epoch, payload: json(null) });
      ended.payload = json({ remoteConfirmed: remote.status === "ended" });
    } catch { /* Local revocation remains immediate; remote confirmation unknown. */ }
    return ended;
  }
}
