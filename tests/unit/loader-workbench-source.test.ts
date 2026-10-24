import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_SOURCE,
  publicWorkbenchSource,
  validateWorkbenchSource,
  WorkbenchSourceError,
} from '../../loader/src/workbench-source.js';

const source = { registry: 'https://registry.example', repository: 'team/workbench' };
describe('workbench source settings', () => {
  it('provides the published origin only as the default and a safe view', () => {
    expect(DEFAULT_WORKBENCH_SOURCE).toEqual({
      registry: 'https://ghcr.io',
      repository: 'shady2k/lifemodel-workbench',
    });
    const value = validateWorkbenchSource({ ...source, username: 'reader', password: 'CANARY' });
    expect(publicWorkbenchSource(value)).toEqual({
      ...source,
      username: 'reader',
      hasPassword: true,
    });
    expect(JSON.stringify(publicWorkbenchSource(value))).not.toContain('CANARY');
  });
  it.each([
    [{ repository: 'x' }, 'registry'],
    [{ registry: source.registry }, 'repository'],
    [{ ...source, registry: 'http://registry.example' }, 'registry'],
    [{ ...source, registry: 'https://user:CANARY@registry.example' }, 'registry'],
    [{ ...source, registry: 'https://@registry.example' }, 'registry'],
    [{ ...source, registry: 'https://registry.exa\tmple' }, 'registry'],
    [{ ...source, registry: 'https://registry.example\\' }, 'registry'],
    [{ ...source, registry: 'https://registry.example/path' }, 'registry'],
    [{ ...source, registry: 'https://registry.example?x=y' }, 'registry'],
    [{ ...source, registry: 'https://registry.example#x' }, 'registry'],
    [{ ...source, repository: 'Team/Workbench' }, 'repository'],
    [{ ...source, repository: '../workbench' }, 'repository'],
    [{ ...source, repository: 'team/workbench:tag' }, 'repository'],
    [{ ...source, password: 'CANARY' }, 'username'],
    [{ ...source, username: 'reader' }, 'password'],
  ])('rejects invalid source %j with a safe field reason', (value, field) => {
    try {
      validateWorkbenchSource(value);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchSourceError);
      expect((error as WorkbenchSourceError).fields).toHaveProperty(field);
      expect(String(error)).not.toContain('CANARY');
    }
  });
  it('accepts OCI separators, HTTPS ports, and strips a root slash', () => {
    expect(
      validateWorkbenchSource({
        registry: 'https://registry.example:5443/',
        repository: 'team/a__b.c-d--e',
      })
    ).toEqual({ registry: 'https://registry.example:5443', repository: 'team/a__b.c-d--e' });
  });
  it('preserves an omitted password only for the same source and username; explicit empty clears', () => {
    const old = { ...source, username: 'reader', password: 'CANARY' };
    expect(validateWorkbenchSource({ ...source, username: 'reader' }, old)).toEqual(old);
    expect(validateWorkbenchSource({ ...source, username: 'reader', password: '' }, old)).toEqual(
      source
    );
    expect(validateWorkbenchSource({ ...source, username: '' }, old)).toEqual(source);
    expect(() =>
      validateWorkbenchSource(
        { ...source, registry: 'https://other.example', username: 'reader' },
        old
      )
    ).toThrow(WorkbenchSourceError);
    expect(() => validateWorkbenchSource({ ...source, username: 'other' }, old)).toThrow(
      WorkbenchSourceError
    );
    expect(() =>
      validateWorkbenchSource({ ...source, repository: 'other/image', username: 'reader' }, old)
    ).toThrow(WorkbenchSourceError);
    expect(
      validateWorkbenchSource({ ...source, username: 'other', password: 'replacement' }, old)
    ).toEqual({ ...source, username: 'other', password: 'replacement' });
  });
});

it('refuses a whitespace-only pull secret before the importer can retry it', () => {
  expect(() =>
    validateWorkbenchSource({
      registry: 'https://registry.example',
      repository: 'team/workbench',
      username: 'reader',
      password: '   ',
    })
  ).toThrow('invalid_workbench_source');
});
