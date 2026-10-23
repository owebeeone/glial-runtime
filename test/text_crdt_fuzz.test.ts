import { it, expect } from 'vitest';
import { GlialBinder } from '../src/binder.ts';
import { assembleTextCrdt } from '../src/text_crdt.ts';
import type { BindingDecl } from '@owebeeone/glade-decl';

const decl: BindingDecl = { glade_id: { id: 'fuzz.text' }, shape: 'crdt', authority: 'share', source: null,
  domain: 'document', zone: 'commons', retention: { policy: 'from_cursor', ttl_ms: null } };
const start = Number(process.env.CRDT_FUZZ_START ?? 1);
const count = Number(process.env.CRDT_FUZZ_SEEDS ?? 30);
for (let seed = start; seed < start + count; seed++) {
  it(`mounted random concurrent edits and delivery seed ${seed}`, () => {
    let random = seed;
    const pick = (n: number) => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % n; };
    const mount = (name: string) => new GlialBinder(undefined, name).mount(decl, { domain: 'same' }, undefined, { crdtProfile: 'text_crdt' });
    const writers = [mount('alice'), mount('bob'), mount('carol')];
    for (let edit = 0; edit < 30; edit++) {
      const writer = writers[pick(writers.length)];
      const text = Array.from(writer.instance.textCrdtState().text);
      const at = pick(text.length + 1);
      text.splice(at, pick(4), ...Array.from(['X', '🙂', '\nabc', ''][pick(4)]));
      writer.instance.replaceText(text.join(''));
      if (pick(3) === 0) {
        const other = writers[pick(writers.length)];
        other.instance.ingest(writer.instance.operations());
      }
    }
    const all = [...new Map(writers.flatMap(w => w.instance.operations()).map(o => [JSON.stringify([o.origin, o.seq]), o])).values()];
    const readers = [mount('reader1'), mount('reader2')];
    for (let replica = 0; replica < readers.length; replica++) {
      const reader = readers[replica];
      const queue = all.map((_, i) => i);
      const trace: number[][] = [];
      while (queue.length) {
        const batch: number[] = [];
        const size = 1 + pick(12);
        for (let n = 0; n < size && queue.length; n++) { batch.push(queue.splice(pick(queue.length), 1)[0]); }
        trace.push(batch);
        reader.instance.ingest(batch.map(i => all[i]));
        if (pick(3) === 0) { reader.instance.ingest(batch.map(i => all[i])); }
        expect(reader.instance.textCrdtState(), `seed=${seed}; replica=${replica}; batches=${JSON.stringify(trace)}`)
          .toEqual(assembleTextCrdt(reader.instance.operations()));
      }
    }
    expect(readers[0].instance.textCrdtState()).toEqual(readers[1].instance.textCrdtState());
    for (const m of [...writers, ...readers]) { m.unmount(); }
  });
}
