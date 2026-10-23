import { expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { IndexedDbStoreEngine } from '../src/store_idb.ts';
import { GlialBinder } from '../src/binder.ts';
import type { BindingDecl } from '@owebeeone/glade-decl';
const decl: BindingDecl = { glade_id: { id: 'checkpoint.text' }, shape: 'crdt', authority: 'share', source: null,
  domain: 'document', zone: 'commons', retention: { policy: 'from_cursor', ttl_ms: null } };
it('refresh uses a matching durable engine/projection checkpoint without historical apply', async () => {
  const factory = new IDBFactory();
  const store = await IndexedDbStoreEngine.open('recovery', factory);
  const mounted = new GlialBinder(store, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  mounted.instance.replaceText('hello🙂'.repeat(60));
  const expected = mounted.instance.textCrdtState();
  mounted.unmount();
  await store.flush(); store.close();
  const reopened = await IndexedDbStoreEngine.open('recovery', factory);
  const recovered = new GlialBinder(reopened, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  expect(recovered.instance.textCrdtState()).toEqual(expected);
  expect(recovered.instance.textCrdtWork().applied).toBe(0);
  expect(recovered.instance.textCrdtWork().textDecodes).toBe(0);
  recovered.instance.replaceText(expected.text + '!');
  expect(recovered.instance.textCrdtWork().applied).toBe(1);
  recovered.unmount(); await reopened.flush(); reopened.close();
});

it('refresh between checkpoints replays only the durable tail; incompatible checkpoint falls back', async () => {
  const factory = new IDBFactory();
  const store = await IndexedDbStoreEngine.open('tail', factory);
  const mounted = new GlialBinder(store, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  mounted.instance.replaceText('a'.repeat(256)); // periodic checkpoint
  mounted.instance.replaceText('a'.repeat(256) + 'tail');
  await store.flush(); store.close(); // crash-like refresh: no unmount checkpoint
  const reopened = await IndexedDbStoreEngine.open('tail', factory);
  const recovered = new GlialBinder(reopened, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  expect(recovered.instance.textCrdtState().text).toBe('a'.repeat(256) + 'tail');
  expect(recovered.instance.textCrdtWork().applied).toBe(4);
  const key = recovered.instance.key;
  recovered.unmount();
  reopened.open(key).saveCheckpoint!({ version: 999 });
  await reopened.flush(); reopened.close();
  const fallback = await IndexedDbStoreEngine.open('tail', factory);
  const full = new GlialBinder(fallback, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  expect(full.instance.textCrdtState().text).toBe('a'.repeat(256) + 'tail');
  expect(full.instance.textCrdtWork().applied).toBe(260);
  full.unmount(); await fallback.flush(); fallback.close();
});

it('aborting a checkpoint transaction retains the previous consistent baseline and durable tail', async () => {
  const factory = new IDBFactory();
  const store = await IndexedDbStoreEngine.open('aborted', factory);
  const mounted = new GlialBinder(store, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  mounted.instance.replaceText('a'.repeat(256));
  await store.flush();
  mounted.instance.replaceText('a'.repeat(256) + 'tail');
  await store.flush();
  const original = IDBDatabase.prototype.transaction;
  const fault = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
    const tx = original.call(this, names, mode, options);
    if (mode === 'readwrite' && Array.from(typeof names === 'string' ? [names] : names).includes('checkpoints')) {
      queueMicrotask(() => tx.abort());
    }
    return tx;
  });
  try { mounted.unmount(); await store.flush(); }
  finally { fault.mockRestore(); store.close(); }
  const reopened = await IndexedDbStoreEngine.open('aborted', factory);
  const recovered = new GlialBinder(reopened, 'alice').mount(decl, { domain: 'doc' }, undefined, { crdtProfile: 'text_crdt' });
  expect(recovered.instance.textCrdtState().text).toBe('a'.repeat(256) + 'tail');
  expect(recovered.instance.textCrdtWork().applied).toBe(4);
  recovered.unmount(); await reopened.flush(); reopened.close();
});
