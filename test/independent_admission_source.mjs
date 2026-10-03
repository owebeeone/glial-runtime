// Syntax-aware source gate for this tranche; TypeScript is an existing dev dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "../node_modules/typescript/lib/typescript.js";

function violations(source) {
  const file = ts.createSourceFile("contract.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, "source must parse");
  const found = [];
  function visit(node) {
    if (ts.isIfStatement(node)) {
      if (!ts.isBlock(node.thenStatement)) {
        found.push("if");
      }
      if (node.elseStatement && !ts.isBlock(node.elseStatement) && !ts.isIfStatement(node.elseStatement)) {
        found.push("else");
      }
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      if (!ts.isBlock(node.statement)) {
        found.push("loop");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
for (const fixture of ["if (x) x++;", "if (x) {} else x++;", "for (;;) ;", "while (x) ;", "do x++; while (x);"]) {
  assert.equal(violations(fixture).length, 1, fixture);
}
assert.deepEqual(violations("if (x) {} else if (y) {} else {} for (;;) {} while (x) {} do {} while (x);"), []);
for (const file of ["independent_admission_contract.mjs", "independent_admission_source.mjs"]) {
  assert.deepEqual(violations(fs.readFileSync(new URL(file, import.meta.url), "utf8")), [], file);
}
console.log("ICD tranche JavaScript compound bodies: PASS");
