import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InMemoryBindingStore } from '../../src/storage/binding-store.ts';

describe('InMemoryBindingStore sessionName', () => {
  it('setBinding and updateSessionName store the name', () => {
    const store = new InMemoryBindingStore();
    store.setBinding('proj_a', 'chat_123');
    store.updateSessionName('chat_123', 'My Group');
    const all = store.getAllBindings();
    assert.equal(all.length, 1);
    assert.equal((all[0] as any).sessionName, 'My Group');
  });

  it('updateSessionName only updates name, not the binding', () => {
    const store = new InMemoryBindingStore();
    store.setBinding('proj_a', 'chat_123');
    store.updateSessionName('chat_123', 'Updated Name');
    assert.equal(store.getSessionByProject('proj_a'), 'chat_123');
    assert.equal(store.getProjectBySession('chat_123'), 'proj_a');
  });
});
