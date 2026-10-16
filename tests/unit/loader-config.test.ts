import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../loader/src/config.js';
import { LoaderFatalError } from '../../loader/src/errors.js';

describe('platform loader configuration', () => {
  it('defaults to the platform loader state volume and service port', () => {
    expect(() => loadConfig({})).toThrow(LoaderFatalError);
    expect(loadConfig({ LIFEMODEL_NAME: 'lifemodel' })).toEqual({
      instanceName: 'lifemodel',
      volumeRoot: '/var/lib/loader',
      loaderDir: '/var/lib/loader/loader',
      httpPort: 7000,
      openBaoAddress: 'http://openbao.openbao.svc:8200',
    });
  });
  it('reads the volume, OpenBao endpoint and port from the environment', () => {
    expect(
      loadConfig({
        LIFEMODEL_NAME: 'home',
        LIFEMODEL_VOLUME_ROOT: '/tmp/loader',
        LIFEMODEL_OPENBAO_ADDRESS: 'http://bao.test:8200',
        LIFEMODEL_HTTP_PORT: '7100',
      })
    ).toEqual({
      instanceName: 'home',
      volumeRoot: '/tmp/loader',
      loaderDir: '/tmp/loader/loader',
      httpPort: 7100,
      openBaoAddress: 'http://bao.test:8200',
    });
  });
  it('accepts the shared instance-name table', () => {
    for (const value of ['a', 'home', 'a0', 'a-1', `a${'x'.repeat(55)}0`])
      expect(loadConfig({ LIFEMODEL_NAME: value }).instanceName).toBe(value);
  });
  it('rejects invalid instance DNS labels', () => {
    for (const value of [
      'Home',
      '1abc',
      '-home',
      'home-',
      'true',
      '123',
      'null',
      'yes',
      'no',
      'false',
      'on',
      'off',
      'y',
      'n',
      '~',
      'x'.repeat(58),
    ])
      expect(() => loadConfig({ LIFEMODEL_NAME: value })).toThrow(LoaderFatalError);
  });
  it('rejects invalid ports instead of silently choosing a fallback', () => {
    for (const value of ['soon', '-1', '65536'])
      expect(() => loadConfig({ LIFEMODEL_NAME: 'lifemodel', LIFEMODEL_HTTP_PORT: value })).toThrow(
        LoaderFatalError
      );
  });
});
