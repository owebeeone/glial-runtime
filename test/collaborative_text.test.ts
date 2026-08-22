import { describe, expect, it } from "vitest";

import { GlialCollaborativeText } from "../src/index.ts";

describe("Glial collaborative text over the Taut CRDT core", () => {
  it("merges concurrent offline edits and reconnects idempotently", () => {
    const alice = new GlialCollaborativeText("alice");
    const bob = new GlialCollaborativeText("bob");

    alice.insert("root", null, "A");
    alice.reconnect(bob);
    expect(bob.state().text).toBe("A");

    // Both peers now edit while disconnected. Stable atom ids, the common
    // vector envelope, and the shared projection decide the result.
    alice.insert("alice:2", "root", "B");
    bob.insert("bob:1", "root", "C");
    expect(alice.state().text).toBe("AB");
    expect(bob.state().text).toBe("AC");

    alice.reconnect(bob);
    expect(alice.state()).toEqual(bob.state());
    expect(alice.state().text).toBe("ABC");
    expect(alice.state().diagnostics).toEqual([]);

    alice.reconnect(bob);
    expect(alice.state()).toEqual(bob.state());
  });

  it("carries a delete made offline without reviving the item", () => {
    const alice = new GlialCollaborativeText("alice");
    const bob = new GlialCollaborativeText("bob");
    alice.insert("x", null, "X");
    alice.reconnect(bob);
    bob.delete("x");
    bob.reconnect(alice);
    expect(alice.state().text).toBe("");
    expect(alice.state()).toEqual(bob.state());
  });
});
