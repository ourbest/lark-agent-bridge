import assert from 'node:assert/strict';
import test from 'node:test';

import { saveMessageAttachments } from '../../src/services/file-upload-service.ts';

test('returns a complete result shape for empty attachment lists', async () => {
  const downloadCalls: unknown[] = [];

  const result = await saveMessageAttachments({
    cwd: '/tmp/unused',
    attachments: [],
    downloadFile: async (attachment) => {
      downloadCalls.push(attachment);
      return Buffer.from('unexpected');
    },
  });

  assert.deepEqual(result, {
    savedFiles: [],
    errors: [],
  });
  assert.deepEqual(downloadCalls, []);
});
