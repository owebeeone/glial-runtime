import { describe, expect, it } from "vitest";

import {
  LiveMetricsStreamRegistry,
  StreamWriterConflictError,
  fromUtf8,
  utf8,
} from "../src/index.ts";

describe("live metrics over the Taut bounded stream adapter", () => {
  it("makes loss observable and reconnects as a late join without replay", () => {
    const metrics = new LiveMetricsStreamRegistry().declare({
      id: "provider.metrics.live",
      shape: "stream",
      writer: "provider-A",
      capacityRecords: 2,
    });
    const writer = metrics.writer("provider-A");
    const dashboard = metrics.reader("dashboard");

    expect(dashboard.poll().state).toBe("would_block");
    writer.publish(utf8("m1"));
    const first = dashboard.poll();
    expect(first.state).toBe("data");
    expect(first.records.map((record) => fromUtf8(record.payload))).toEqual(["m1"]);

    writer.publish(utf8("m2"));
    writer.publish(utf8("m3"));
    writer.publish(utf8("m4"));
    const dropped = dashboard.poll();
    expect(dropped.state).toBe("dropped");
    expect(dropped.error).toEqual({ code: "slow_consumer", message: null });
    expect(dashboard.lossCount).toBe(1);
    expect(dashboard.connected).toBe(false);

    expect(dashboard.reconnect().state).toBe("would_block");
    writer.publish(utf8("m5"));
    const resumed = dashboard.poll();
    expect(resumed.state).toBe("data");
    expect(resumed.records.map((record) => [record.seq, fromUtf8(record.payload)])).toEqual([
      [5n, "m5"],
    ]);
    expect(dashboard.lossCount).toBe(1);
  });

  it("rejects a second producer identity", () => {
    const metrics = new LiveMetricsStreamRegistry().declare({
      id: "provider.metrics.live",
      shape: "stream",
      writer: "provider-A",
      capacityRecords: 8,
    });
    expect(() => metrics.writer("provider-B")).toThrow(StreamWriterConflictError);
  });
});
