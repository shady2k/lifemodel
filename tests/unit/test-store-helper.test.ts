import { describe, expect, it } from 'vitest';
import { testStoreUrls } from '../helpers/test-stores.js';

describe('test store helper', () => {
  it('fails closed when either launcher-provided store URL is missing', () => {
    expect(() => testStoreUrls({})).toThrow(/LIFEMODEL_TEST_VALKEY_URL and LIFEMODEL_TEST_DATABASE_URL are required/);
    expect(() => testStoreUrls({ LIFEMODEL_TEST_VALKEY_URL: 'redis://valkey:6379' })).toThrow(/required/);
  });
});
