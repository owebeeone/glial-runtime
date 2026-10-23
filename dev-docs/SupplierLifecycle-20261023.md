# Supplier attachment and detach regression

23 October 2026. Status: bounded local fix, tests passed. The operator authorized
a deterministic reproduction and a small repair, separately from the broader
session-assistance implementation plan. No wire, public method signature,
dependency or package-version change was made.

## Reproduction before implementation

`test/supplier.lifecycle.test.ts` uses a multi-handler `SupplierSession`, explicitly
resolved/rejected subscription promises and an injected backoff queue. It uses
no sleeps, external services or wall-clock races. The original implementation
failed all 17 cases:

- Exchange/value/log attachment finished after serving detach or `detachAll`
  and installed a new local handler.
- An already-started reattachment finished after detach and revived hooks.
- An older attachment completed after the new one and left two handlers.
- A detached subscription's later failure scheduled another retry.
- A retained value/log publisher still appended after detach; tests also check
  that an independent active serving remains usable.

RED: 17 failed, test execution 31 ms, total Vitest duration 2.00 seconds.

## Small repair and verification

Each serving now fences asynchronous attachment outcomes and callbacks with a
local generation invalidated by drop/detach. Stale completion cannot install
hooks or trigger `onServe`, and stale failure cannot drive a new retry. The
share publication path refuses detached handles; supplier retry scheduling
checks that the failed serving is still registered.

GREEN focused command:

```powershell
node node_modules/vitest/vitest.mjs run test/supplier.lifecycle.test.ts test/supplier.test.ts
```

All 28 tests passed, test execution 154 ms, total duration 1.35 seconds. Existing
supplier tests include the real in-process Glade client session/store path;
they do not establish a new WebSocket or cross-machine test.

The complete owning-package suite passed: **158 tests in 19 files**, total
duration 1.96 seconds. `node node_modules/typescript/bin/tsc --noEmit` and
`git diff --check` passed. Environment: Windows/ReFS on Magenta, bundled Node 24,
installed Vitest 2.1.9. No new test-selection mechanism or architecture exception
was introduced.

This repair does not provide a remote unsubscribe, revoke arbitrary application
side effects already in progress, establish assistance activation readiness, or
solve lost-result recovery. Those remain separately scoped integration concerns.
