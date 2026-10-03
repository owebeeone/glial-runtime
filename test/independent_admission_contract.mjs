// Internal trace consumer; no independent admission model is implemented in JS.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { CrdtNode, projectText } from "@owebeeone/taut-shape";
const pinned = JSON.parse(fs.readFileSync(new URL("fixtures/independent_concurrent_siblings.json", import.meta.url), "utf8"));
assert.equal(createHash("sha256").update(pinned.source_text).digest("hex"), pinned.sha256);
const corpus = JSON.parse(pinned.source_text);
assert.equal(corpus.name, "concurrent_siblings");
for (const replica of corpus.replicas) {
  const node = new CrdtNode();
  for (const index of replica.order) {
    const op = corpus.ops[index];
    node.handle({type:"apply", op:{origin:op.origin,seq:BigInt(op.seq),
      deps:{entries:op.deps.entries.map(ref => ({origin:ref.origin,seq:BigInt(ref.seq)}))},
      payload:Uint8Array.from(Buffer.from(op.payload,"base64"))}});
  }
  assert.equal(projectText(node).text,"ABC",`released reference corpus ${replica.name}`);
}
console.log("ICD released corpus reference: PASS (three orders; merge only)");
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
function project(result) {
  assert.equal(result.read_available, true, "ICD-011 kernel must return a local cut");
  const node = new CrdtNode();
  for (const op of result.operations) {
    node.handle({ type: "apply", op: {
      origin: op.origin, seq: BigInt(op.seq) + 1n,
      deps: { entries: op.refs.map(ref => ({ origin: ref.origin, seq: BigInt(ref.seq) + 1n })) },
      payload: Uint8Array.from(op.payload),
    } });
  }
  return projectText(node).text;
}
const signatures = input.traces.map(t => `${t.scenario}/${t.reverse ?? "partition"}`).sort();
assert.deepEqual(signatures, ["AB/false", "AB/true", "AB-buffer/false", "AB-buffer/true", "AD/false", "AD/true", "ABC/partition", "A/false", "A/true", "isolation/partition"].sort(),
  "ICD-017 exact real-text witnesses cannot be omitted or duplicated");
const failures = [];
for (const trace of input.traces) {
  try {
    if (trace.scenario === "ABC") {
      assert.deepEqual(trace.local_receipts, [true, true], "ICD-002 both isolated edits need receipts");
      assert.equal(project(trace.left), "ABC", "ICD-003 released concurrent text");
      assert.equal(project(trace.right), "ABC", "ICD-012 reverse reconciliation");
      const identities = result => result.operations.map(op => `${op.origin}:${op.seq}`).sort();
      assert.deepEqual(identities(trace.left), ["a:0", "b:0", "c:0"]);
      assert.deepEqual(identities(trace.left), identities(trace.right));
      for (const result of [trace.left,trace.right]) {
        for (const op of result.operations) {
          const canonical = corpus.ops.find(value => value.origin === op.origin);
          assert.ok(canonical,"ICD-017 each actual operation belongs to pinned corpus");
          assert.equal(BigInt(op.seq)+1n,BigInt(canonical.seq));
          assert.deepEqual(op.payload, [...Buffer.from(canonical.payload,"base64")],"ICD-003 exact canonical payload bytes");
          assert.deepEqual(op.refs.map(ref => ({origin:ref.origin,seq:(BigInt(ref.seq)+1n).toString()})),canonical.deps.entries);
        }
      }
    } else if (trace.scenario === "isolation") {
      assert.equal(project(trace.x), "A", "ICD-004 instance X remains A");
      assert.equal(project(trace.y), "Y", "ICD-004 authorized instance Y remains Y");
      assert.equal(trace.denied, true, "ICD-004 denied Y writer cannot borrow X rights");
      assert.notDeepEqual(trace.x_instance, trace.y_instance);
    } else {
      assert.equal(project(trace.result), trace.scenario === "AB-buffer" ? "AB" : trace.scenario, `ICD-006/007/009 expected ${trace.scenario}`);
      if (trace.scenario === "A") {
        assert.equal(trace.result.quarantine["writer-e0"], 1, "ICD-009 two qualified rival admissions convict");
        assert.deepEqual(trace.result.operations.map(op => `${op.origin}:${op.seq}`), ["writer-e0:0"]);
      }
      if (trace.scenario === "AD") {
        assert.equal(trace.result.security_evidence, 1, "ICD-009 unadmitted rival retained");
        assert.deepEqual(trace.result.quarantine, {}, "ICD-009 unadmitted rival cannot convict");
      }
      if (trace.scenario === "AB" || trace.scenario === "AB-buffer") {
        assert.deepEqual(trace.result.operations.map(op => `${op.origin}:${op.seq}`).sort(), ["writer-e0:0", "writer-e1:0"]);
      }
      if (trace.scenario === "AB") {
        assert.equal(project(trace.before_recovery), "A", "ICD-009 genuine fork precedes recovery");
        assert.equal(trace.before_recovery.quarantine["writer-e0"], 1);
        assert.equal(trace.result.quarantine["writer-e0"], 1, "fresh recovery does not erase old fork");
        assert.equal(trace.qualified_fork, true, "two historically qualifying E0 rivals retained");
        assert.equal(trace.old_receipts_preserved, true);
        assert.equal(trace.old_retries_exact, true);
        assert.equal(trace.reused_origin_rejected, true);
        assert.equal(trace.fresh_local_receipt, true, "eligible old prefix permits fresh local recovery");
      }
    }
  } catch (error) {
    failures.push(`${trace.scenario}/${trace.reverse ?? "partition"}: ${error.message}`);
  }
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log("ICD released text consumer: PASS");
