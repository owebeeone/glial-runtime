import { expect, it } from "vitest";
import { bindAssistance } from "../src/assistance/glade.ts";
import { AssistanceSupplier } from "../src/assistance/index.ts";
it("cancels a pending concrete subscribe and cannot become ready or leave hooks after close", async () => {
  let release!: (v: { ok: boolean }) => void, hooks = 0, closed = 0;
  const client: any = { session: { origin: "x" },
    subscribeOutcome: () => new Promise(r => { release = r; }),
    onExchangeReq: () => { hooks++; return () => { hooks--; }; }, onDrop: () => () => {}, addOpsListener: () => () => {},
    close: () => { closed++; }, append() {}, respondExchange() {},
  };
  const host = new AssistanceSupplier({ application: "a", workspace: "w", supplier: "s", generation: "g" },
    { capabilities: { version: "1", actions: {} }, read: () => ({ revision: "r", sequence: 0 }), prepare: async () => () => {} }, { now: () => 0, id: () => "id" });
  const binding = bindAssistance(client, "share", host);
  const done = expect(binding.ready).rejects.toThrow("closed");
  await Promise.resolve(); await Promise.resolve(); binding.close(); release({ ok: true }); await done;
  await Promise.resolve(); await Promise.resolve(); expect(hooks).toBe(0); expect(closed).toBe(1);
});
