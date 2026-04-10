import assert from 'node:assert/strict';
import test from 'node:test';

import { providerToAdapterType } from '../../src/runtime/provider-registry.ts';

test('maps gemini provider names to the gemini CLI adapter type', () => {
  assert.equal(providerToAdapterType('gemini'), 'gemini-cli');
});
