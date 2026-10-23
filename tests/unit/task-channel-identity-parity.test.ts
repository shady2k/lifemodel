import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('task channel identity verifier', () => {
  it('keeps every live Kubernetes proof check identical to the model listener', () => {
    const model = readFileSync('loader/src/task-kubernetes-identity.ts', 'utf8');
    const channel = readFileSync('src/core/task-kubernetes-identity.ts', 'utf8');
    expect(channel).toBe(
      model
        .replace(
          "import { StorageAccessError } from './storage-access-error.js';",
          "import { TaskChannelError as StorageAccessError } from '../ports/task-channel.js';"
        )
        .replace(
          "options.audience ?? 'lifemodel-task-model'",
          "options.audience ?? 'lifemodel-task-channel'"
        )
    );
  });
});
