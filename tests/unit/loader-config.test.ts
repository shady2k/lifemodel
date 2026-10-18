import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../loader/src/config.js';
import { LoaderFatalError } from '../../loader/src/errors.js';

describe('platform loader configuration', () => {
  it('defaults to the platform loader state volume and service port', () => {
    expect(loadConfig({ LIFEMODEL_NAME: 'lifemodel' })).toEqual({
      volumeRoot: '/var/lib/loader',
      loaderDir: '/var/lib/loader/loader',
      httpPort: 7000,
      openBaoAddress: 'http://openbao.openbao.svc:8200',
      modelStatusUrl: 'http://model-gateway.lifemodel-system.svc:8081/status',
      instanceName: 'lifemodel',
    });
  });
  it('reads the volume, OpenBao endpoint and port from the environment', () => {
    expect(
      loadConfig({
        LIFEMODEL_VOLUME_ROOT: '/tmp/loader',
        LIFEMODEL_OPENBAO_ADDRESS: 'http://bao.test:8200',
        LIFEMODEL_HTTP_PORT: '7100',
        LIFEMODEL_NAME: 'home',
      })
    ).toEqual({
      volumeRoot: '/tmp/loader',
      loaderDir: '/tmp/loader/loader',
      httpPort: 7100,
      openBaoAddress: 'http://bao.test:8200',
      modelStatusUrl: 'http://model-gateway.lifemodel-system.svc:8081/status',
      instanceName: 'home',
    });
  });
  it('requires a valid instance name', () => {
    expect(() => loadConfig({})).toThrow(LoaderFatalError);
    expect(() => loadConfig({ LIFEMODEL_NAME: 'bad.name' })).toThrow(LoaderFatalError);
  });
  it('reads the gateway status URL and refuses a value that is not HTTP', () => {
    expect(
      loadConfig({
        LIFEMODEL_NAME: 'home',
        LIFEMODEL_MODEL_GATEWAY_STATUS_URL: 'http://gateway.test:8081/status',
      }).modelStatusUrl
    ).toBe('http://gateway.test:8081/status');
    expect(
      loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_MODEL_GATEWAY_STATUS_URL: '' }).modelStatusUrl
    ).toBe('http://model-gateway.lifemodel-system.svc:8081/status');
    for (const value of ['gateway.test:8081/status', 'ftp://gateway.test/status'])
      expect(() =>
        loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_MODEL_GATEWAY_STATUS_URL: value })
      ).toThrow(LoaderFatalError);
  });
  it('rejects invalid ports instead of silently choosing a fallback', () => {
    for (const value of ['soon', '-1', '65536'])
      expect(() => loadConfig({ LIFEMODEL_HTTP_PORT: value, LIFEMODEL_NAME: 'home' })).toThrow(
        LoaderFatalError
      );
  });
});
