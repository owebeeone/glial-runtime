import { describe, expect, it } from "vitest";
import type { BindingDecl } from "@owebeeone/glade-decl";

import { GlialBinder } from "../src/binder.ts";
import type { InstanceEvent } from "../src/events.ts";
import { instanceKey } from "../src/instance.ts";
import { MemoryStoreEngine } from "../src/store.ts";
import {
  encodeSwmrAction,
  projectFileWindow,
  SwmrAdapterError,
} from "../src/swmr.ts";
import { fromUtf8, utf8 } from "../src/bytes.ts";

const FILES: BindingDecl = {
  glade_id: { id: "ws.files" },
  shape: "swmr",
  authority: "share",
  source: null,
  domain: "document",
  zone: "commons",
  retention: { policy: "from_cursor", ttl_ms: null },
};
const FILL = { domain: "doc-1" };

describe("Glial canonical SWMR assembly", () => {
  it("assembles snapshot + full-image delta and projects a bounded file window", () => {
    const events: InstanceEvent[] = [];
    const mount = new GlialBinder(undefined, "writer-a").mount(FILES, FILL, (event) => events.push(event));

    mount.instance.writeSwmr("snapshot", utf8("alpha"));
    mount.instance.writeSwmr("delta", utf8("alphabet"));

    const latest = events.at(-1)!;
    expect(latest.envelope.shape).toBe("swmr");
    expect(latest.envelope.kind).toBe("delta");
    expect(latest.swmr).toMatchObject({ state: "data", writerId: "writer-a", epoch: 0n, seq: 1n });
    expect(fromUtf8(latest.swmr!.value!)).toBe("alphabet");

    const window = projectFileWindow(latest.swmr!, { from: 2, length: 3 });
    expect(fromUtf8(window.bytes)).toBe("pha");
    expect(window).toMatchObject({ from: 2, length: 3, total: 8, revision: "0:1" });
  });

  it("rejects delta-before-snapshot before mutating the instance store", () => {
    const engine = new MemoryStoreEngine();
    const mount = new GlialBinder(engine, "writer-a").mount(FILES, FILL);

    expect(() => mount.instance.writeSwmr("delta", utf8("orphan"))).toThrow(
      expect.objectContaining({ code: "GLIAL_SWMR_INVALID", reason: "delta_before_snapshot" }),
    );
    expect(engine.open(instanceKey(FILES.glade_id.id, FILL)).all()).toEqual([]);
  });

  it("rejects a second writer batch atomically", () => {
    const engine = new MemoryStoreEngine();
    const mount = new GlialBinder(engine, "writer-a").mount(FILES, FILL);
    mount.instance.writeSwmr("snapshot", utf8("kept"));

    expect(() => mount.instance.ingest([
      {
        origin: "writer-b",
        seq: 1,
        lamport: 2,
        prev: null,
        payload: encodeSwmrAction("snapshot", utf8("rejected")),
      },
    ])).toThrow(expect.objectContaining({ code: "GLIAL_SWMR_INVALID", reason: "writer_conflict" }));

    const held = engine.open(instanceKey(FILES.glade_id.id, FILL)).all();
    expect(held).toHaveLength(1);
    expect(fromUtf8(projectFileWindow(mount.instance.swmrAssembly(), { from: 0, length: 99 }).bytes)).toBe("kept");
  });

  it("reset advances the epoch and never exposes bytes from the prior generation", () => {
    const events: InstanceEvent[] = [];
    const mount = new GlialBinder(undefined, "writer-a").mount(FILES, FILL, (event) => events.push(event));
    mount.instance.writeSwmr("snapshot", utf8("old-generation"));
    mount.instance.writeSwmr("reset", utf8("checkout"));

    const reset = events.at(-1)!.swmr!;
    expect(reset).toMatchObject({ state: "reset", epoch: 1n, value: null });
    expect(projectFileWindow(reset, { from: 0, length: 99 }).bytes).toHaveLength(0);

    mount.instance.writeSwmr("snapshot", utf8("new"));
    const fresh = events.at(-1)!.swmr!;
    expect(fresh).toMatchObject({ state: "data", epoch: 1n, seq: 0n });
    expect(fromUtf8(projectFileWindow(fresh, { from: 0, length: 99 }).bytes)).toBe("new");
  });

  it("rejects malformed adapter bytes before mutation", () => {
    const engine = new MemoryStoreEngine();
    const mount = new GlialBinder(engine, "writer-a").mount(FILES, FILL);

    expect(() => mount.instance.write(new Uint8Array([1, 99]))).toThrow(SwmrAdapterError);
    expect(engine.open(instanceKey(FILES.glade_id.id, FILL)).all()).toEqual([]);
  });

  it("requires a connected destination to expose its authenticated writer before send", () => {
    let sends = 0;
    const mount = new GlialBinder(undefined, "local").mount(FILES, FILL, undefined, {
      glade: {
        send: () => {
          sends += 1;
          throw new Error("send must not be reached");
        },
        subscribe: () => () => {},
      },
    });

    expect(() => mount.instance.writeSwmr("snapshot", utf8("whole"))).toThrow(
      expect.objectContaining({ code: "GLIAL_SWMR_INVALID", reason: "missing_writer_origin" }),
    );
    expect(sends).toBe(0);
  });
});
