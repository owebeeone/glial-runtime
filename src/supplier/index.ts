// The glial SUPPLIER kit (GLP-0006 P0.S4) — the authority-side counterpart of
// the grip-side tap adapter. A supplier is a wire-attached authority session
// (P00-a, RULED): given declared surfaces + handlers it attaches over a
// GladeClient-shaped session and SERVES them. It wraps R4's proven provider
// choreography (`glade/node/src/exchange.rs`; the stage-1 audit harness) — NO
// new wire.
//
// Own subpath, like the grip adapter (`@owebeeone/glial-runtime/supplier`): the
// KERNEL (binder / instance / folds / store / session / events) stays
// dependency-clean — this module imports `@owebeeone/glade-decl` types + the
// kernel's byte helpers, and NOTHING grip.
//
// TWO node mechanisms, one seam — the shape distinction is load-bearing
// (`dev-docs/glade/GladeSupplierModel.md` §2, RULED 2026-07-12):
//   * EXCHANGE surfaces → `serveExchange`. A Subscribe on a DECLARED exchange
//     glade id registers the session as THE provider in the node's `providers`
//     map (`attach_provider`); the supplier answers each `ExchangeReq` with
//     `corr` preserved. This IS an attach ceremony.
//   * VALUE / LOG / WINDOW surfaces → `serveShare`. There is NO provider-map
//     entry: the claim-holding AUTHORITY is the NODE that holds the surface's
//     `ServeClaim` (node-side, minted by F1), and "serving" is simply the
//     supplier session APPENDING ops into the surface's streams (which fold +
//     replicate to subscribers). Any session may append in stage-1 — serving is
//     op-publishing, NOT an attach ceremony. A subscribe here only RECEIVES the
//     surface's inbound ops so the supplier-side source can fold them.

import type { GladeId, Shape } from "@owebeeone/glade-decl";
import { bytesEq } from "../bytes.ts";

// ---- surface (the BindingDecl-shaped subset a supplier addresses) ----------

/** The declared surface a supplier stands behind, as it is addressed on the
 *  wire: `(share, glade id, shape, key)`. BindingDecl-shaped — the S5a typed
 *  Surface handle satisfies this structurally (it carries the same fields), so
 *  `serve*` accept `M.notes` as well as a raw literal. `share` is the concrete
 *  replicated world (the decl's domain default resolved by grazel config); an
 *  absent/empty `key` is the commons zone. */
export interface SupplierSurface {
  readonly glade_id: GladeId;
  readonly shape: Shape;
  readonly share: string;
  readonly key?: Uint8Array;
}

function surfaceKey(s: SupplierSurface): Uint8Array | undefined {
  return s.key && s.key.length ? s.key : undefined;
}

// ---- wire-shaped data the kit sees (no new wire) ---------------------------

/** A wire op as a supplier sees it — the minimal fields the share path reads.
 *  The client-ts `Op` (share / glade_id / key / origin / seq / prev / lamport /
 *  refs / shape / payload) satisfies this structurally. */
export interface SupplierOp {
  share: string;
  glade_id: string;
  key: Uint8Array;
  origin: string;
  seq: number;
  payload: Uint8Array;
}

/** An inbound directed request routed to this provider — the wire `ExchangeReq`
 *  (tag 6), decoded. `corr` MUST be echoed 1:1 in the answer. */
export interface ExchangeRequest {
  share: string;
  glade_id: string;
  corr: string;
  payload: Uint8Array;
}

/** A handler's answer to one request. `ok` defaults to true when a payload is
 *  present and false when an `error` is; a thrown/rejected handler becomes
 *  `ok:false` with the message — failure as DATA (§4/§6), never a hang. */
export interface ExchangeAnswer {
  ok?: boolean;
  payload?: Uint8Array;
  error?: string;
}

/** The full `ExchangeRes` a session ships — corr resolved, ok explicit. */
export interface ExchangeReply {
  corr: string;
  ok: boolean;
  payload?: Uint8Array;
  error?: string;
}

/** Answer an inbound directed request. Return an {@link ExchangeAnswer}; throw
 *  (or reject) to answer `ok:false` with the thrown message as data. */
export type ExchangeHandler = (req: ExchangeRequest) => ExchangeAnswer | Promise<ExchangeAnswer>;

// ---- share serving (op-publishing, NOT an attach ceremony) -----------------

/** The controller a {@link ShareSource} publishes through. `set` is the
 *  value-shape op (whole-value refresh, lww); `append` is the log-shape op (one
 *  entry). Each APPENDS an op into the surface's stream — which is what "serving"
 *  a value/log surface IS. Wrong-shape use throws. */
export interface ShareController {
  set(payload: Uint8Array): SupplierOp;
  append(payload: Uint8Array): SupplierOp;
}

/** The supplier-side origin of a value/log surface's content. `onServe` receives
 *  the publish controller (once per attach, including after a reattach); `onOp`
 *  receives the surface's inbound ops so the source can fold them (any session
 *  may append in stage-1). */
export interface ShareSource {
  onServe?(ctl: ShareController): void;
  onOp?(op: SupplierOp): void;
}

// ---- the session seam (structural, ws-free-testable) -----------------------

/** The structural view of an authority session a supplier attaches over — the
 *  provider half of the wire, no concrete client class (mirrors the kernel's
 *  `SessionLike` / `OpBus` seams). A client-ts `GladeClient` is the intended
 *  concrete satisfier; see the INTEGRATION POINTS on each member for the
 *  provider-side hooks the parallel glade work still owes. Tests use a fake. */
export interface SupplierSession {
  readonly origin: string;

  /** Subscribe a declared surface. The NODE routes by the surface's SHAPE
   *  (`server.rs`; `exchange.rs::declared_exchange`): an exchange id registers
   *  this session as THE provider (`attach_provider`); a value/log/window id is
   *  an ordinary subscribe that streams the surface's ops back — the
   *  claim-holding authority is the node, not this call. Resolves on the node's
   *  `Heads` ack. */
  subscribe(share: string, gladeId: string, key?: Uint8Array): Promise<void> | void;

  /** INTEGRATION POINT (parallel glade work — client-ts today decodes tag-6
   *  frames but drops them): surface inbound `ExchangeReq` frames to the
   *  attached provider. Returns an unsubscribe. */
  onExchangeReq(handler: (req: ExchangeRequest) => void): () => void;

  /** INTEGRATION POINT: answer a directed request (the tag-7 `ExchangeRes`),
   *  `corr` preserved 1:1 — the node relays it to the recorded requester. */
  respondExchange(reply: ExchangeReply): void;

  /** Append + ship one op into a share zone (the value/log SERVING act); returns
   *  the authoritative op. (`GladeClient.append` already provides this.) */
  append(share: string, gladeId: string, shape: string, payload: Uint8Array, key?: Uint8Array): SupplierOp;

  /** Inbound ops for subscribed shares. Returns an unsubscribe. INTEGRATION
   *  POINT: `GladeClient.onOps` is today a single settable field — a client
   *  serving several surfaces needs this as a fan-out (multiple handlers). */
  onOps(handler: (ops: SupplierOp[]) => void): () => void;

  /** Optional principal attribution (§4). The glade agent is adding
   *  `Hello(principal)` to client-ts in parallel; called defensively so this
   *  commit stands alone (`client.hello?.(principal)`). */
  hello?(principal: string): void | Promise<void>;

  /** Optional link-drop signal driving reattach-on-drop (§2.5). When the
   *  concrete client cannot signal a drop, reattach is a no-op and callers drive
   *  it by re-`serve*`-ing; when it can, the kit re-Hellos + re-Subscribes with
   *  backoff. Returns an unsubscribe. */
  onDrop?(handler: () => void): () => void;
}

// ---- reattach backoff (injectable schedule for tests) ----------------------

export interface BackoffConfig {
  /** First delay after a drop (ms). Default 250. */
  initialMs?: number;
  /** Multiplier per consecutive failed reattach. Default 2. */
  factor?: number;
  /** Delay ceiling (ms). Default 10_000. */
  maxMs?: number;
}

/** Schedules `fn` after `ms`; returns a cancel. Injectable so tests drive the
 *  clock (default is `setTimeout`). */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

const defaultSchedule: ScheduleFn = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function backoffMs(cfg: BackoffConfig | undefined, attempt: number): number {
  const initial = cfg?.initialMs ?? 250;
  const factor = cfg?.factor ?? 2;
  const max = cfg?.maxMs ?? 10_000;
  return Math.min(max, initial * factor ** attempt);
}

// ---- per-surface servings --------------------------------------------------

/** One live serving — an exchange provider or a share publisher. Re-`attach`ed
 *  after a drop; `detach` is the clean teardown. */
interface Serving {
  /** Clean detach: stop reattaching and drop this surface's wire hooks. */
  detach(): void;
}

interface InternalServing extends Serving {
  attach(): Promise<void>;
  /** The link dropped — the old connection's hooks are gone; forget them so a
   *  reattach re-registers cleanly. */
  markDropped(): void;
}

class ExchangeServing implements InternalServing {
  private reqOff?: () => void;
  private detached = false;

  constructor(
    private readonly session: SupplierSession,
    private readonly surface: SupplierSurface,
    private readonly handler: ExchangeHandler,
  ) {}

  async attach(): Promise<void> {
    if (this.detached) return;
    this.reqOff?.();
    // Subscribe → the node registers THIS session as the provider for the
    // declared exchange id (attach_provider). Resolves on the Heads ack.
    await this.session.subscribe(this.surface.share, this.surface.glade_id.id, surfaceKey(this.surface));
    this.reqOff = this.session.onExchangeReq((req) => this.onReq(req));
  }

  private onReq(req: ExchangeRequest): void {
    // A client may multiplex several providers over one session — only answer
    // requests routed to THIS surface (the node routes to us, but be defensive).
    if (req.share !== this.surface.share || req.glade_id !== this.surface.glade_id.id) return;
    Promise.resolve()
      .then(() => this.handler(req))
      .then((ans) =>
        this.session.respondExchange({
          corr: req.corr,
          ok: ans.ok ?? (ans.error === undefined),
          payload: ans.payload,
          error: ans.error,
        }),
      )
      .catch((e) =>
        // A thrown/rejected handler is failure-as-DATA (§6), corr intact.
        this.session.respondExchange({ corr: req.corr, ok: false, error: String((e && e.message) ?? e) }),
      );
  }

  markDropped(): void {
    this.reqOff = undefined;
  }

  detach(): void {
    this.detached = true;
    this.reqOff?.();
    this.reqOff = undefined;
  }
}

class ShareServing implements InternalServing {
  private opsOff?: () => void;
  private detached = false;
  private readonly ctl: ShareController;
  private readonly isLog: boolean;

  constructor(
    private readonly session: SupplierSession,
    private readonly surface: SupplierSurface,
    private readonly source: ShareSource,
  ) {
    this.isLog = surface.shape === "log";
    this.ctl = {
      set: (payload) => {
        if (this.isLog) throw new Error(`serveShare ${surface.glade_id.id}: set() is a value-shape op; use append() for a log`);
        return this.publish(payload);
      },
      append: (payload) => {
        if (!this.isLog) throw new Error(`serveShare ${surface.glade_id.id}: append() is a log-shape op; use set() for a value`);
        return this.publish(payload);
      },
    };
  }

  /** The SERVING act: append an op into the surface's stream. The claim-holding
   *  authority is the node (F1); this session just publishes content. */
  private publish(payload: Uint8Array): SupplierOp {
    return this.session.append(
      this.surface.share,
      this.surface.glade_id.id,
      this.surface.shape,
      payload,
      surfaceKey(this.surface),
    );
  }

  async attach(): Promise<void> {
    if (this.detached) return;
    this.opsOff?.();
    // NOT an attach ceremony: a value/log subscribe only RECEIVES the surface's
    // inbound ops (any session may append in stage-1) so the source can fold
    // them. The claim/authority lives with the node.
    await this.session.subscribe(this.surface.share, this.surface.glade_id.id, surfaceKey(this.surface));
    this.opsOff = this.session.onOps((ops) => this.onOps(ops));
    this.source.onServe?.(this.ctl);
  }

  private onOps(ops: SupplierOp[]): void {
    const wantKey = this.surface.key ?? new Uint8Array();
    for (const op of ops) {
      if (op.share !== this.surface.share || op.glade_id !== this.surface.glade_id.id) continue;
      if (!bytesEq(op.key ?? new Uint8Array(), wantKey)) continue;
      this.source.onOp?.(op);
    }
  }

  markDropped(): void {
    this.opsOff = undefined;
  }

  detach(): void {
    this.detached = true;
    this.opsOff?.();
    this.opsOff = undefined;
  }
}

// ---- the supplier ----------------------------------------------------------

export interface SupplierConfig {
  /** Principal for attribution (§4) — sent via `session.hello` when supported. */
  principal?: string;
  /** Reattach backoff shape. */
  backoff?: BackoffConfig;
  /** Injectable scheduler for the backoff (tests drive the clock). */
  schedule?: ScheduleFn;
}

/** A supplier: one authority session, several served surfaces. Compose it (the
 *  supplier is standing authority, not a per-mount consumer) and call
 *  `serveExchange` / `serveShare` per surface. Reattaches every serving on a
 *  link drop with backoff; `detachAll` is the clean teardown. */
export class Supplier {
  private readonly servings = new Set<InternalServing>();
  private readonly dropOff?: () => void;
  private cancelBackoff?: () => void;
  private attempt = 0;
  private helloed = false;
  private detached = false;

  constructor(
    private readonly session: SupplierSession,
    private readonly config: SupplierConfig = {},
  ) {
    this.dropOff = session.onDrop?.(() => this.onDrop());
  }

  /** Serve a DECLARED EXCHANGE surface: Subscribe registers this session as THE
   *  provider (attach_provider); each inbound `ExchangeReq` runs `handler` and
   *  is answered with `corr` preserved (errors → `ok:false` data). */
  serveExchange(surface: SupplierSurface, handler: ExchangeHandler): Serving {
    return this.register(new ExchangeServing(this.session, surface, handler));
  }

  /** Serve a VALUE / LOG surface: publish ops through the source's controller
   *  (`set` / `append`) and fold the surface's inbound ops into the source. This
   *  is op-publishing, NOT a provider attach — the ServeClaim / authority lives
   *  with the NODE (F1); any session may append in stage-1. */
  serveShare(surface: SupplierSurface, source: ShareSource): Serving {
    return this.register(new ShareServing(this.session, surface, source));
  }

  /** Detach every serving and stop reattaching. */
  detachAll(): void {
    this.detached = true;
    this.cancelBackoff?.();
    this.cancelBackoff = undefined;
    this.dropOff?.();
    for (const s of this.servings) s.detach();
    this.servings.clear();
  }

  private register(s: InternalServing): Serving {
    this.servings.add(s);
    void this.attachOne(s);
    return {
      detach: () => {
        this.servings.delete(s);
        s.detach();
      },
    };
  }

  private async attachOne(s: InternalServing): Promise<void> {
    try {
      await this.ensureHello();
      await s.attach();
      this.attempt = 0; // a clean attach resets the backoff
    } catch {
      this.scheduleReattach(); // attach failed — back off and retry the lot
    }
  }

  private async ensureHello(): Promise<void> {
    if (this.helloed) return;
    this.helloed = true;
    if (this.config.principal !== undefined && this.session.hello) {
      // Attribution is best-effort in stage-1: a hello failure must not wedge
      // the supplier (identity as data, nothing enforced — §4).
      try {
        await this.session.hello(this.config.principal);
      } catch {
        /* ignore */
      }
    }
  }

  private onDrop(): void {
    if (this.detached) return;
    for (const s of this.servings) s.markDropped();
    this.helloed = false; // a fresh connection re-Hellos
    this.attempt = 0;
    this.scheduleReattach();
  }

  private scheduleReattach(): void {
    if (this.detached) return;
    const ms = backoffMs(this.config.backoff, this.attempt);
    const schedule = this.config.schedule ?? defaultSchedule;
    this.cancelBackoff = schedule(() => void this.reattachAll(), ms);
  }

  private async reattachAll(): Promise<void> {
    if (this.detached) return;
    try {
      await this.ensureHello();
      for (const s of this.servings) await s.attach();
      this.attempt = 0; // success resets
    } catch {
      this.attempt += 1; // consecutive failures back off exponentially
      this.helloed = false;
      this.scheduleReattach();
    }
  }
}

/** Attach a supplier over an authority session (says Hello with the principal
 *  once a surface is served). Sugar for `new Supplier(session, config)`. */
export function attachSupplier(session: SupplierSession, config?: SupplierConfig): Supplier {
  return new Supplier(session, config);
}
