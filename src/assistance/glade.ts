/** Concrete Glade-shaped adapter. All wire request correlation remains in Glade. */
import { Supplier, type SupplierSession } from "../supplier/index.ts";
import { assistanceIR, loadSchema, encode, decode, type AssistanceAdvertisement, type AssistanceRequest, type AssistanceResult } from "@owebeeone/glade-decl/assistance";
import { AssistanceSupplier, result } from "./index.ts";
const schema = loadSchema(assistanceIR);
const service = "assistance.session.v1", directory = "assistance.directory.v1";
export interface Client {
  session: { origin: string };
  subscribeOutcome(share: string, id: string, key?: Uint8Array): Promise<{ ok: boolean }>;
  onExchangeReq: SupplierSession["onExchangeReq"];
  respondExchange: SupplierSession["respondExchange"];
  append: SupplierSession["append"];
  addOpsListener: SupplierSession["onOps"];
  onDrop(fn: () => void): () => void;
  close(): void;
  exchange(share: string, id: string, payload: Uint8Array): Promise<{ ok: boolean; payload?: Uint8Array; error?: string }>;
  appendOutcome(share: string, id: string, shape: string, payload: Uint8Array): Promise<{ ok: boolean }>;
}
/** Dedicated assistance connection: closing never touches application synchronization. */
export function bindAssistance(client: Client, share: string, host: AssistanceSupplier) {
  let closed = false, resolve!: () => void, reject!: (e: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const port: SupplierSession = {
    origin: client.session.origin,
    async subscribe(s, id, key) {
      try { const outcome = await client.subscribeOutcome(s, id, key); if (!outcome.ok) { throw Error("subscription refused"); } }
      catch (error) { close(); reject(error instanceof Error ? error : Error("subscription failed")); throw error; }
    },
    onExchangeReq(fn) {
      if (closed) { return () => {}; }
      const off = client.onExchangeReq(fn); host.setReady(true); resolve(); return off;
    },
    respondExchange: reply => { if (!closed) { client.respondExchange(reply); } },
    append: (...args) => client.append(...args),
    onOps: fn => client.addOpsListener(fn),
  };
  const supplier = new Supplier(port);
  const offDrop = client.onDrop(() => close());
  function close() {
    if (closed) { return; } closed = true;
    host.setReady(false); supplier.detachAll(); offDrop(); client.close(); reject(Error("assistance binding closed"));
  }
  supplier.serveExchange({ share, glade_id: { id: service }, shape: "exchange" }, async request => {
    if (closed) { return { ok: false, error: "closed" }; }
    let answer: AssistanceResult;
    try {
      if (request.payload.byteLength > 65_536) { throw Error("request too large"); }
      answer = await host.receive(decode(schema, "AssistanceRequest", request.payload));
    } catch { answer = result("invalid", null, { reason: "malformed request" }); }
    return { payload: encode(schema, "AssistanceResult", answer) };
  });
  return { ready, close };
}
/** Bounded wait only. A late answer is ignored; it is never recovered or reissued. */
export async function callAssistance(client: Client, share: string, request: AssistanceRequest): Promise<AssistanceResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.exchange(share, service, encode(schema, "AssistanceRequest", request)).then(reply => {
        if (!reply.ok || !reply.payload) { return result("unknown", null, { reason: reply.error ?? "no application response" }); }
        return decode(schema, "AssistanceResult", reply.payload) as AssistanceResult;
      }),
      new Promise<AssistanceResult>(resolve => { timer = setTimeout(() => resolve(result("unknown", null, { reason: "transport wait expired; manual handling required" })), 10_000); }),
    ]);
  } finally { clearTimeout(timer); }
}
export async function advertise(client: Client, directoryShare: string, advert: AssistanceAdvertisement) {
  const out = await client.appendOutcome(directoryShare, directory, "log", encode(schema, "AssistanceAdvertisement", advert));
  if (!out.ok) { throw Error("advertisement refused"); }
}
export async function watchDirectory(client: Client, share: string, receive: (a: AssistanceAdvertisement) => void) {
  let active = true;
  const off = client.addOpsListener(ops => {
    if (!active) { return; }
    for (const op of ops) {
      if (op.share !== share || op.glade_id !== directory || op.payload.byteLength > 65_536) { continue; }
      try { const a = decode(schema, "AssistanceAdvertisement", op.payload) as AssistanceAdvertisement; if (a.version === 1n) { receive(a); } }
      catch { /* Malformed discovery records do not confer authority. */ }
    }
  });
  const stop = () => { active = false; off(); };
  try { const outcome = await client.subscribeOutcome(share, directory); if (!outcome.ok) { throw Error("directory refused"); } }
  catch (error) { stop(); throw error; }
  return stop;
}
