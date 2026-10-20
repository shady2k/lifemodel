import { describe, expect, it } from 'vitest';
import {
  createSettingsRegistry,
  SettingsDeclarationError,
  type SettingDeclaration,
} from '../../loader/src/settings/registry.js';
import { platformSettings } from '../../loader/src/settings/platform.js';

const concurrency: SettingDeclaration = {
  key: 'tasks.concurrency',
  section: 'tasks',
  label: {
    en: 'Concurrent tasks',
    ru: '\u041f\u0430\u0440\u0430\u043b\u043b\u0435\u043b\u044c\u043d\u044b\u0435 \u0437\u0430\u0434\u0430\u0447\u0438',
  },
  description: {
    en: 'How many tasks may run at the same time.',
    ru: '\u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0437\u0430\u0434\u0430\u0447 \u043c\u043e\u0433\u0443\u0442 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u0442\u044c\u0441\u044f \u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  min: 1,
  max: 8,
  authority: 'owner',
  apply: 'nextAdmission',
};

describe('settings declaration registry', () => {
  it('registers a declaration and enumerates it', () => {
    const registry = createSettingsRegistry([concurrency]);
    expect(registry.declarations()).toHaveLength(1);
    expect(registry.get('tasks.concurrency')).toEqual(concurrency);
  });

  it('refuses a duplicate key', () => {
    expect(() => createSettingsRegistry([concurrency, concurrency])).toThrow(
      new SettingsDeclarationError('duplicate setting key "tasks.concurrency"')
    );
  });

  it('refuses an unknown key when validating a value', () => {
    const registry = createSettingsRegistry([concurrency]);
    const result = registry.validate('no.such.key', 3);
    expect(result).toMatchObject({ ok: false, reasonCode: 'unknown_key' });
    expect(result.ok === false && result.reason).toContain('no.such.key');
  });

  it("refuses a wrong type with the declaration's reason", () => {
    const registry = createSettingsRegistry([concurrency]);
    const result = registry.validate('tasks.concurrency', 'many');
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'wrong_type',
    });
    expect(result.ok === false && result.reason).toContain('tasks.concurrency');
  });

  it('refuses out-of-bounds values with the declared bounds', () => {
    const registry = createSettingsRegistry([concurrency]);
    const below = registry.validate('tasks.concurrency', 0);
    expect(below).toMatchObject({ ok: false, reasonCode: 'below_minimum', limit: 1 });
    const above = registry.validate('tasks.concurrency', 9);
    expect(above).toMatchObject({ ok: false, reasonCode: 'above_maximum', limit: 8 });
    expect(above.ok === false && above.reason).toContain('8');
  });

  it('accepts a valid value', () => {
    const registry = createSettingsRegistry([concurrency]);
    expect(registry.validate('tasks.concurrency', 4)).toEqual({ ok: true, value: 4 });
  });

  it('refuses a select value outside the declared options', () => {
    const registry = createSettingsRegistry([
      {
        key: 'tasks.harness',
        section: 'tasks',
        label: { en: 'Harness', ru: 'Harness' },
        description: { en: 'Which harness runs a task.', ru: 'Which harness runs a task.' },
        control: 'select',
        dataClass: 'publicConfig',
        default: 'opencode',
        options: [{ value: 'opencode', label: { en: 'OpenCode', ru: 'OpenCode' } }],
        authority: 'owner',
        apply: 'nextAdmission',
      },
    ]);
    expect(registry.validate('tasks.harness', 'vim')).toMatchObject({
      ok: false,
      reasonCode: 'not_an_option',
    });
  });

  it('refuses to set a secret: set, delete and exists only, no value path', () => {
    const registry = createSettingsRegistry([
      {
        key: 'tasks.token',
        section: 'tasks',
        label: { en: 'Token', ru: 'Token' },
        description: { en: 'A secret.', ru: 'A secret.' },
        control: 'secret',
        dataClass: 'secretAuthenticator',
        authority: 'owner',
        apply: 'immediate',
      },
    ]);
    const declaration = registry.get('tasks.token');
    expect(declaration).toBeDefined();
    expect(declaration && 'default' in declaration && declaration.default !== undefined).toBe(
      false
    );
    const result = registry.validate('tasks.token', 'hush');
    expect(result).toMatchObject({ ok: false, reasonCode: 'secret_setting' });
    expect(result.ok === false && result.reason).toContain('OpenBao');
    // No value of a secret is ever held or read back by the registry.
    expect(registry.declarations().every((d) => d.control !== 'secret' || !('default' in d))).toBe(
      true
    );
  });

  it('refuses a secret declared with a default', () => {
    expect(() =>
      createSettingsRegistry([
        {
          key: 'tasks.token',
          section: 'tasks',
          label: { en: 'Token', ru: 'Token' },
          description: { en: 'A secret.', ru: 'A secret.' },
          control: 'secret',
          dataClass: 'secretAuthenticator',
          default: 'hush',
          authority: 'owner',
          apply: 'immediate',
        },
      ])
    ).toThrow(new SettingsDeclarationError('a secret setting must not declare a default'));
  });

  it.each([
    ['', 'key'],
    ['Tasks', 'key'],
    ['tasks..concurrency', 'key'],
  ])('refuses the malformed key %j', (key) => {
    expect(() => createSettingsRegistry([{ ...concurrency, key }])).toThrow(
      SettingsDeclarationError
    );
  });

  it('refuses a select declaration without options or with a default outside them', () => {
    const base = {
      key: 'tasks.harness',
      section: 'tasks',
      label: { en: 'Harness', ru: 'Harness' },
      description: { en: 'Which harness.', ru: 'Which harness.' },
      control: 'select',
      dataClass: 'publicConfig',
      authority: 'owner',
      apply: 'nextAdmission',
    } satisfies SettingDeclaration;
    expect(() => createSettingsRegistry([{ ...base, default: 'opencode' }])).toThrow(
      SettingsDeclarationError
    );
    expect(() =>
      createSettingsRegistry([
        {
          ...base,
          default: 'vim',
          options: [{ value: 'opencode', label: { en: 'OpenCode', ru: 'OpenCode' } }],
        },
      ])
    ).toThrow(SettingsDeclarationError);
  });

  it('refuses a number declaration whose default or bounds contradict each other', () => {
    expect(() => createSettingsRegistry([{ ...concurrency, default: 20 }])).toThrow(
      SettingsDeclarationError
    );
    expect(() => createSettingsRegistry([{ ...concurrency, min: 8, max: 1 }])).toThrow(
      SettingsDeclarationError
    );
  });

  it('declares the platform tasks.concurrency setting: number 1..8, default 2, section tasks', () => {
    const declaration = platformSettings.get('tasks.concurrency');
    expect(declaration).toMatchObject({
      key: 'tasks.concurrency',
      section: 'tasks',
      control: 'number',
      default: 2,
      min: 1,
      max: 8,
      authority: 'owner',
      apply: 'nextAdmission',
    });
    expect(declaration?.label.en).toBeTruthy();
    expect(declaration?.label.ru).toBeTruthy();
    expect(declaration?.description.en).toBeTruthy();
    expect(declaration?.description.ru).toBeTruthy();
  });
});
