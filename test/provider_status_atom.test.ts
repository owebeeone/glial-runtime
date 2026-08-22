import { describe, expect, it } from "vitest";

import {
  AtomWriterConflictError,
  ProviderStatusAtomRegistry,
  fromUtf8,
  utf8,
} from "../src/index.ts";

describe("provider status over the Taut atom adapter", () => {
  it("rejects a second writer at declaration and writer boundaries", () => {
    const registry = new ProviderStatusAtomRegistry();
    const status = registry.declare({
      id: "provider.status",
      shape: "atom",
      writer: "provider-A",
    });

    expect(() => registry.declare({
      id: "provider.status",
      shape: "atom",
      writer: "provider-B",
    })).toThrow(expect.objectContaining({ code: "GLIAL_ATOM_SECOND_WRITER" }));
    expect(() => status.writer("provider-B")).toThrow(AtomWriterConflictError);
  });

  it("replaces status and reconnects from the last observed version", () => {
    const status = new ProviderStatusAtomRegistry().declare({
      id: "provider.status",
      shape: "atom",
      writer: "provider-A",
    });
    const writer = status.writer("provider-A");

    writer.replace(utf8("online"));
    const first = status.reconnect("reader-1", 0n);
    expect(first.state).toBe("data");
    expect(first.value?.version).toBe(1n);
    expect(fromUtf8(first.value!.payload)).toBe("online");

    writer.replace(utf8("busy"));
    status.adapter.endStream("provider.status", "reader-1");
    const resumed = status.reconnect("reader-1-reconnected", 1n);
    expect(resumed.state).toBe("data");
    expect(resumed.value?.version).toBe(2n);
    expect(fromUtf8(resumed.value!.payload)).toBe("busy");

    const caughtUp = status.reconnect("reader-caught-up", 2n);
    expect(caughtUp.state).toBe("would_block");
    expect(caughtUp.value).toBeNull();
  });
});
