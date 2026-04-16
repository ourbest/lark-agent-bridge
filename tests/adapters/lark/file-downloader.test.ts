import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { downloadFeishuFile } from '../../../src/adapters/lark/file-downloader.ts';

test('downloads audio resources using the file resource type', async () => {
  let requestedType: string | null = null;
  let requestedMessageId: string | null = null;
  let requestedFileKey: string | null = null;

  const client = {
    im: {
      v1: {
        messageResource: {
          async get(payload: { params: { type: string }; path: { message_id: string; file_key: string } }) {
            requestedType = payload.params.type;
            requestedMessageId = payload.path.message_id;
            requestedFileKey = payload.path.file_key;

            return {
              headers: {
                'content-disposition': 'attachment; filename="voice.opus"',
                'content-type': 'audio/opus',
                'content-length': '4',
              },
              getReadableStream: () => Readable.from([Buffer.from('test')]),
            };
          },
        },
      },
    },
  };

  const file = await downloadFeishuFile(
    client as never,
    'msg_123',
    'file_v3_0010m_test',
    'audio',
  );

  assert.equal(requestedType, 'file');
  assert.equal(requestedMessageId, 'msg_123');
  assert.equal(requestedFileKey, 'file_v3_0010m_test');
  assert.equal(file.fileName, 'voice.opus');
  assert.equal(file.mimeType, 'audio/opus');
  assert.equal(file.fileSize, 4);
  assert.equal(file.buffer.toString('utf8'), 'test');
});

test('decodes utf-8 encoded filenames from content-disposition', async () => {
  const client = {
    im: {
      v1: {
        messageResource: {
          async get() {
            return {
              headers: {
                'content-disposition': "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%96%87%E4%BB%B6.txt",
                'content-type': 'application/octet-stream',
                'content-length': '4',
              },
              getReadableStream: () => Readable.from([Buffer.from('test')]),
            };
          },
        },
      },
    },
  };

  const file = await downloadFeishuFile(
    client as never,
    'msg_123',
    'file_v3_0010m_test',
    'file',
  );

  assert.equal(file.fileName, '中文文件.txt');
});

test('recovers mojibake filenames from content-disposition', async () => {
  const client = {
    im: {
      v1: {
        messageResource: {
          async get() {
            return {
              headers: {
                'content-disposition': 'attachment; filename="ä¸­ææä»¶.txt"',
                'content-type': 'application/octet-stream',
                'content-length': '4',
              },
              getReadableStream: () => Readable.from([Buffer.from('test')]),
            };
          },
        },
      },
    },
  };

  const file = await downloadFeishuFile(
    client as never,
    'msg_123',
    'file_v3_0010m_test',
    'file',
  );

  assert.equal(file.fileName, '中文文件.txt');
});
