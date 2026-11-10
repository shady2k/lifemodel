import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('crash walk native CRI container lookup', () => {
  it.each(['k3s crictl', '/opt/bin/crictl --runtime-endpoint unix:///run/containerd.sock'])(
    'looks up the container metadata name in its selected pod with %s',
    (command) => {
      const result = spawnSync(
        'python3',
        ['tests/fixtures/logs-crash-cri-harness.py', 'deploy/platform/logs-crash-walk.py', command],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.pid, value.pidReason).toBe(4242);
      expect(value.memory, value.memoryReason).toBe(104857600);
      for (const args of value.commands.filter((args: string[]) => args.includes('ps'))) {
        expect(args[args.indexOf('--name') + 1]).toBe('logs-collector');
        expect(args).toContain('io.kubernetes.pod.name=logs-collector-5h28h');
        expect(args).toContain('io.kubernetes.pod.namespace=lifemodel-logs');
      }
      expect(value.commands[0].slice(0, command.split(' ').length)).toEqual(command.split(' '));
    }
  );
});
