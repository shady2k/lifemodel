import { describe, expect, it } from 'vitest';
import { migrationUpSql } from '../../scripts/apply-migrations.js';

describe('dbmate migration format', () => {
  it('requires exactly one up marker and a later down marker, with empty down allowed', () => {
    expect(migrationUpSql('-- migrate:up\nSELECT 1;\n-- migrate:down\n', 'valid.sql')).toBe('SELECT 1;');
    expect(() => migrationUpSql('-- migrate:up\nSELECT 1;', 'missing-down.sql')).toThrow(/one later -- migrate:down/);
    expect(() => migrationUpSql('-- migrate:down\n-- migrate:up\nSELECT 1;', 'wrong-order.sql')).toThrow(/one later -- migrate:down/);
    expect(() => migrationUpSql('-- migrate:up\nSELECT 1;\n-- migrate:down\nDROP TABLE core.example;', 'rollback.sql')).toThrow(/rollback SQL is not allowed/);
  });
});
