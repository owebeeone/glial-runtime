import { expect, it } from 'vitest';
import { TextCrdtAssembler, assembleTextCrdt, encodeTextEdit } from '../src/text_crdt.ts';
import type { StoredOp } from '../src/store.ts';

function op(seq: number, origin = 'a'): StoredOp {
  return { origin, seq, lamport: seq, prev: null, refs: [],
    payload: encodeTextEdit({ kind: 'insert', atomId: `${origin}${seq}`, after: null, text: `${seq}` }) };
}
it('rejects a checkpoint paired with different causal references', () => {
  const assembler = new TextCrdtAssembler();
  assembler.apply([op(1)]);
  expect(() => TextCrdtAssembler.restore(assembler.checkpoint(), [
    { ...op(1), refs: [{ origin: 'missing', seq: 4 }] },
  ])).toThrow('checkpoint does not match');
});
it('late earlier sequences and newly known reference origins match full reconstruction', () => {
  const assembler = new TextCrdtAssembler();
  const history: StoredOp[] = [];
  for (const next of [op(5), op(7), { ...op(2, 'b'), refs: [{ origin: 'c', seq: 4 }] }, op(4, 'c'), op(6), op(4), op(5)]) {
    if (!history.some(o => o.origin === next.origin && o.seq === next.seq)) { history.push(next); }
    assembler.apply([next]);
    expect(assembler.state()).toEqual(assembleTextCrdt(history));
  }
});
it('rejects an invalid batch without changing the retained engine', () => {
  const assembler = new TextCrdtAssembler();
  assembler.apply([op(1)]);
  const before = assembler.state();
  expect(() => assembler.apply([op(2), { ...op(3), payload: new Uint8Array([255]) }])).toThrow();
  expect(assembler.state()).toBe(before);
  assembler.apply([op(2)]);
  expect(assembler.state()).toEqual(assembleTextCrdt([op(1), op(2)]));
});
