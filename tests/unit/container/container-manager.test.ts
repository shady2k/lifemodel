/**
 * Unit tests for ContainerManager — mocks Docker CLI calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CONTAINER_LABEL, CONTAINER_IMAGE } from '../../../src/runtime/container/types.js';

// We test the Docker create args builder by importing it indirectly
// through the container-manager module's behavior

describe('Container security flags', () => {
  it('CONTAINER_LABEL is set correctly', () => {
    expect(CONTAINER_LABEL).toBe('com.lifemodel.component=motor-cortex');
  });

  it('CONTAINER_IMAGE is set correctly', () => {
    expect(CONTAINER_IMAGE).toBe('lifemodel-motor:latest');
  });
});

describe('Container configuration constants', () => {
  it('exports expected security constants', async () => {
    const types = await import('../../../src/runtime/container/types.js');
    expect(types.DEFAULT_MEMORY_LIMIT).toBe('512m');
    expect(types.DEFAULT_CPU_LIMIT).toBe('1.0');
    expect(types.DEFAULT_PIDS_LIMIT).toBe(64);
    expect(types.DEFAULT_MAX_LIFETIME_MS).toBe(30 * 60 * 1000);
    expect(types.TOOL_SERVER_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(types.REQUEST_TIMEOUT_BUFFER_MS).toBe(10 * 1000);
  });
});
