import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { JsonBindingStore } from '../../src/storage/json-binding-store.ts';

test('persists the last thread for a chat and project pair', () => {
  const filePath = path.join('/tmp', `codex-bridge-thread-store-${Date.now()}.json`);
  try {
    const store = new JsonBindingStore(filePath);
    store.setLastThreadId('project-a', 'chat-a', 'thr_123');

    const reloaded = new JsonBindingStore(filePath);
    assert.equal(reloaded.getLastThreadId('project-a', 'chat-a'), 'thr_123');
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});
