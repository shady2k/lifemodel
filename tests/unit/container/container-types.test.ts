/**
 * Unit tests for container IPC protocol types and framing.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  type ToolServerRequest,
  type ToolServerResponse,
  type ToolExecuteRequest,
  type ToolExecuteResponse,
} from '../../../src/runtime/container/types.js';

describe('encodeFrame', () => {
  it('encodes a message with 4-byte length header', () => {
    const msg: ToolServerRequest = { type: 'shutdown' };
    const frame = encodeFrame(msg);

    // Read length header
    const payloadLength = frame.readUInt32BE(0);
    const payload = frame.subarray(4).toString('utf-8');

    expect(payloadLength).toBe(Buffer.byteLength(JSON.stringify(msg), 'utf-8'));
    expect(JSON.parse(payload)).toEqual(msg);
  });

  it('encodes complex messages correctly', () => {
    const msg: ToolExecuteRequest = {
      type: 'execute',
      id: 'req-1',
      tool: 'code',
      args: { code: 'Math.pow(2, 10)' },
      timeoutMs: 30000,
    };
    const frame = encodeFrame(msg);

    const payloadLength = frame.readUInt32BE(0);
    const payload = frame.subarray(4, 4 + payloadLength).toString('utf-8');

    expect(JSON.parse(payload)).toEqual(msg);
  });
});

describe('FrameDecoder', () => {
  it('decodes a single complete frame', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const msg = { type: 'shutdown' };
    const frame = encodeFrame(msg as ToolServerRequest);

    decoder.push(frame);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('decodes multiple frames in a single chunk', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const msg1: ToolServerRequest = { type: 'shutdown' };
    const msg2: ToolExecuteRequest = {
      type: 'execute',
      id: 'req-1',
      tool: 'code',
      args: { code: '1+1' },
      timeoutMs: 5000,
    };

    const combined = Buffer.concat([encodeFrame(msg1), encodeFrame(msg2)]);
    decoder.push(combined);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
  });

  it('handles partial frames across multiple pushes', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const msg: ToolServerRequest = { type: 'credential', name: 'api_key', value: 'secret123' };
    const frame = encodeFrame(msg);

    // Split frame in the middle
    const mid = Math.floor(frame.length / 2);
    decoder.push(frame.subarray(0, mid));
    expect(messages).toHaveLength(0); // Not yet complete

    decoder.push(frame.subarray(mid));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('handles frame split at the length header boundary', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const msg: ToolServerRequest = { type: 'shutdown' };
    const frame = encodeFrame(msg);

    // Push only the header first
    decoder.push(frame.subarray(0, 4));
    expect(messages).toHaveLength(0);

    // Push the payload
    decoder.push(frame.subarray(4));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('handles byte-by-byte pushes', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const msg: ToolServerRequest = { type: 'shutdown' };
    const frame = encodeFrame(msg);

    for (let i = 0; i < frame.length; i++) {
      decoder.push(frame.subarray(i, i + 1));
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('throws on absurdly large frames', () => {
    const decoder = new FrameDecoder(() => {});

    const header = Buffer.alloc(4);
    header.writeUInt32BE(20 * 1024 * 1024, 0); // 20MB

    expect(() => decoder.push(header)).toThrow('Frame too large');
  });

  it('throws on invalid JSON', () => {
    const decoder = new FrameDecoder(() => {});

    const badPayload = Buffer.from('not json', 'utf-8');
    const frame = Buffer.alloc(4 + badPayload.length);
    frame.writeUInt32BE(badPayload.length, 0);
    badPayload.copy(frame, 4);

    expect(() => decoder.push(frame)).toThrow('Invalid JSON');
  });

  it('decodes response types correctly', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    const response: ToolExecuteResponse = {
      type: 'result',
      id: 'req-1',
      result: {
        ok: true,
        output: '1024',
        retryable: false,
        provenance: 'internal',
        durationMs: 5,
      },
    };

    decoder.push(encodeFrame(response));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(response);
  });

  it('handles empty payload', () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((msg) => messages.push(msg));

    // Zero-length payload with just "{}"
    const payload = Buffer.from('{}', 'utf-8');
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);

    decoder.push(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({});
  });
});
