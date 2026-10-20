/**
 * The platform settings registry: one typed declaration per setting (ADR-014
 * D6). A declaration carries the key, a typed default, localized label and
 * description, the section, the control kind, the data class, bounds and unit,
 * the options, the declared authority and the apply timing. Registration
 * refuses duplicates and contradictions; value validation refuses unknown
 * keys, wrong types and out-of-bounds values with the declaration's own
 * reason.
 *
 * The module is pure: no I/O and no storage. Secrets declare set, delete and
 * exists only - never a default and never a read; their values belong to
 * OpenBao and are wired there, not here.
 */

/** The control a screen renders for the setting. */
export type SettingControl = 'toggle' | 'number' | 'select' | 'text' | 'secret';

/** How the value may be exported, logged and stored (never a storage route). */
export type SettingDataClass =
  | 'publicConfig'
  | 'privateMetadata'
  | 'privateContent'
  | 'secretAuthenticator';

/** Who may change the value: the owner here, or the agent through a consent-gated operation. */
export type SettingAuthority = 'owner' | 'agent';

/** When a changed value takes effect. */
export type ApplyTiming = 'immediate' | 'nextAdmission';

export interface LocalizedText {
  en: string;
  ru: string;
}

export interface SelectOption {
  value: string;
  label: LocalizedText;
}

export interface SettingDeclaration {
  /**
   * A dotted key with a lowercase first segment (later segments may be
   * camelCase), unique across every home of the registry.
   */
  key: string;
  /** The grouping id the screen renders the setting under. */
  section: string;
  label: LocalizedText;
  description: LocalizedText;
  control: SettingControl;
  dataClass: SettingDataClass;
  /** The value before anything is stored. A secret has none. */
  default?: boolean | number | string;
  /** The choices of a select control. */
  options?: SelectOption[];
  /** The declared bounds of a number control, stated on the screen. */
  min?: number;
  max?: number;
  /** What a number counts, localized ("tasks"/"задачи"). Never lives in prose. */
  unit?: LocalizedText;
  /**
   * A value the owner can never change: the registry refuses every write and
   * a screen renders the declared default as fixed text with no input.
   */
  readOnly?: boolean;
  /** How a number is displayed. 'bytes' renders a decimal byte count (20 GB). */
  format?: 'bytes';
  authority: SettingAuthority;
  apply: ApplyTiming;
}

/** Why a declaration or a value was refused. */
export type SettingRefusalCode =
  | 'unknown_key'
  | 'wrong_type'
  | 'below_minimum'
  | 'above_maximum'
  | 'too_long'
  | 'empty'
  | 'not_an_option'
  | 'read_only'
  | 'secret_setting';

export type ValueCheck =
  | { ok: true; value: boolean | number | string }
  | { ok: false; reasonCode: SettingRefusalCode; reason: string; limit?: number };

/** A declaration that contradicts itself is a programmer error, not a runtime value error. */
export class SettingsDeclarationError extends Error {}

/** One load-time or value problem, safe to show the owner. */
export interface SettingProblem {
  code: string;
  key?: string;
  reason: string;
}

/**
 * The section payload the loader serves and a screen renders: the
 * declarations, the effective values of the non-secret declarations, the
 * revision, the load problems and the projection state. Secret declarations
 * are listed but carry no value and no default.
 */
export interface SettingsSectionPayload {
  declarations: readonly SettingDeclaration[];
  values: Record<string, boolean | number | string>;
  revision: number;
  problems: readonly SettingProblem[];
  projection: { state: 'unattempted' | 'ok' | 'failed'; reason?: string };
}

/**
 * A dotted key whose first segment is lowercase; later segments may be
 * camelCase (the platform declares tasks.wrapGraceSeconds and friends), so
 * the grammar admits an uppercase after a segment's first character only.
 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9-]*)+$/;

const CONTROLS: readonly SettingControl[] = ['toggle', 'number', 'select', 'text', 'secret'];
const DATA_CLASSES: readonly SettingDataClass[] = [
  'publicConfig',
  'privateMetadata',
  'privateContent',
  'secretAuthenticator',
];
const AUTHORITIES: readonly SettingAuthority[] = ['owner', 'agent'];
const APPLY_TIMINGS: readonly ApplyTiming[] = ['immediate', 'nextAdmission'];

function assertLocalized(text: LocalizedText, what: string, key: string): void {
  for (const language of ['en', 'ru'] as const) {
    if (typeof text[language] !== 'string' || text[language].trim() === '')
      throw new SettingsDeclarationError(`${key}: ${what} needs a non-empty ${language} text`);
  }
}

function assertDeclaration(declaration: SettingDeclaration): void {
  if (!KEY_PATTERN.test(declaration.key))
    throw new SettingsDeclarationError(
      `setting key ${JSON.stringify(declaration.key)} must be a dotted key with a lowercase first segment`
    );
  if (typeof declaration.section !== 'string' || declaration.section.trim() === '')
    throw new SettingsDeclarationError(`${declaration.key}: section must not be empty`);
  assertLocalized(declaration.label, 'label', declaration.key);
  assertLocalized(declaration.description, 'description', declaration.key);
  if (!CONTROLS.includes(declaration.control))
    throw new SettingsDeclarationError(
      `${declaration.key}: unknown control ${JSON.stringify(declaration.control)}`
    );
  if (!DATA_CLASSES.includes(declaration.dataClass))
    throw new SettingsDeclarationError(
      `${declaration.key}: unknown data class ${JSON.stringify(declaration.dataClass)}`
    );
  if (!AUTHORITIES.includes(declaration.authority))
    throw new SettingsDeclarationError(`${declaration.key}: unknown authority`);
  if (!APPLY_TIMINGS.includes(declaration.apply))
    throw new SettingsDeclarationError(`${declaration.key}: unknown apply timing`);
  if (declaration.unit !== undefined) assertLocalized(declaration.unit, 'unit', declaration.key);
  if (declaration.format !== undefined && declaration.format !== 'bytes')
    throw new SettingsDeclarationError(`${declaration.key}: unknown format`);
  if (declaration.format !== undefined && declaration.control !== 'number')
    throw new SettingsDeclarationError(`${declaration.key}: a bytes format needs a number control`);
  if (declaration.readOnly !== undefined && typeof declaration.readOnly !== 'boolean')
    throw new SettingsDeclarationError(`${declaration.key}: readOnly must be a boolean`);
  if (declaration.readOnly === true && declaration.control === 'secret')
    throw new SettingsDeclarationError('a read-only secret cannot exist: a secret is never read');
  if (declaration.control === 'secret') {
    if ('default' in declaration && declaration.default !== undefined)
      throw new SettingsDeclarationError('a secret setting must not declare a default');
    if ('options' in declaration || 'min' in declaration || 'max' in declaration)
      throw new SettingsDeclarationError(
        `${declaration.key}: a secret setting declares no options or bounds`
      );
    return;
  }
  if (declaration.control === 'select') {
    if (!declaration.options || declaration.options.length === 0)
      throw new SettingsDeclarationError(
        `${declaration.key}: a select declares at least one option`
      );
    if (typeof declaration.default !== 'string')
      throw new SettingsDeclarationError(`${declaration.key}: a select declares a string default`);
    if (!declaration.options.some((option) => option.value === declaration.default))
      throw new SettingsDeclarationError(
        `${declaration.key}: the default must be one of the declared options`
      );
    return;
  }
  if (declaration.control === 'number') {
    if (typeof declaration.default !== 'number' || !Number.isFinite(declaration.default))
      throw new SettingsDeclarationError(`${declaration.key}: a number declares a finite default`);
    if (
      (declaration.min !== undefined && !Number.isFinite(declaration.min)) ||
      (declaration.max !== undefined && !Number.isFinite(declaration.max))
    )
      throw new SettingsDeclarationError(`${declaration.key}: bounds must be finite numbers`);
    if (
      declaration.min !== undefined &&
      declaration.max !== undefined &&
      declaration.min > declaration.max
    )
      throw new SettingsDeclarationError(
        `${declaration.key}: the minimum must not exceed the maximum`
      );
    if (declaration.min !== undefined && declaration.default < declaration.min)
      throw new SettingsDeclarationError(
        `${declaration.key}: the default is below the declared minimum`
      );
    if (declaration.max !== undefined && declaration.default > declaration.max)
      throw new SettingsDeclarationError(
        `${declaration.key}: the default is above the declared maximum`
      );
    return;
  }
  if (declaration.control === 'toggle') {
    if (typeof declaration.default !== 'boolean')
      throw new SettingsDeclarationError(`${declaration.key}: a toggle declares a boolean default`);
    return;
  }
  if (typeof declaration.default !== 'string')
    throw new SettingsDeclarationError(`${declaration.key}: a text declares a string default`);
}

/** The value check behind every write. Pure, so every consumer refuses alike. */
export function checkValue(declaration: SettingDeclaration, value: unknown): ValueCheck {
  if (declaration.readOnly)
    return {
      ok: false,
      reasonCode: 'read_only',
      reason: `${declaration.key} is fixed; it cannot be changed`,
    };
  if (declaration.control === 'secret')
    return {
      ok: false,
      reasonCode: 'secret_setting',
      reason: `${declaration.key} is a secret: it is set through OpenBao and is never stored or read here`,
    };
  if (declaration.control === 'toggle') {
    if (typeof value !== 'boolean')
      return {
        ok: false,
        reasonCode: 'wrong_type',
        reason: `${declaration.key} expects true or false`,
      };
    return { ok: true, value };
  }
  if (declaration.control === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return { ok: false, reasonCode: 'wrong_type', reason: `${declaration.key} expects a number` };
    if (declaration.min !== undefined && value < declaration.min)
      return {
        ok: false,
        reasonCode: 'below_minimum',
        reason: `value ${String(value)} is below the declared minimum ${String(declaration.min)}`,
        limit: declaration.min,
      };
    if (declaration.max !== undefined && value > declaration.max)
      return {
        ok: false,
        reasonCode: 'above_maximum',
        reason: `value ${String(value)} is above the declared maximum ${String(declaration.max)}`,
        limit: declaration.max,
      };
    return { ok: true, value };
  }
  if (declaration.control === 'select') {
    if (typeof value !== 'string')
      return { ok: false, reasonCode: 'wrong_type', reason: `${declaration.key} expects a string` };
    if (!declaration.options?.some((option) => option.value === value))
      return {
        ok: false,
        reasonCode: 'not_an_option',
        reason: `value ${JSON.stringify(value)} is not one of the declared options of ${declaration.key}`,
      };
    return { ok: true, value };
  }
  if (typeof value !== 'string')
    return { ok: false, reasonCode: 'wrong_type', reason: `${declaration.key} expects text` };
  if (value === '' && typeof declaration.default === 'string' && declaration.default !== '')
    return { ok: false, reasonCode: 'empty', reason: `${declaration.key} must not be empty` };
  return { ok: true, value };
}

/** The settings of one home: the declarations and the checks every write passes. */
export interface SettingsRegistry {
  register(declaration: SettingDeclaration): void;
  declarations(): readonly SettingDeclaration[];
  get(key: string): SettingDeclaration | undefined;
  /** Refuses an unknown key, a wrong type, or an out-of-bounds value; passes a typed value. */
  validate(key: string, value: unknown): ValueCheck;
}

export function createSettingsRegistry(
  declarations: readonly SettingDeclaration[] = []
): SettingsRegistry {
  const byKey = new Map<string, SettingDeclaration>();
  const registry: SettingsRegistry = {
    register(declaration) {
      assertDeclaration(declaration);
      if (byKey.has(declaration.key))
        throw new SettingsDeclarationError(`duplicate setting key "${declaration.key}"`);
      byKey.set(declaration.key, declaration);
    },
    declarations: () => [...byKey.values()],
    get: (key) => byKey.get(key),
    validate(key, value) {
      const declaration = byKey.get(key);
      if (declaration === undefined)
        return { ok: false, reasonCode: 'unknown_key', reason: `unknown setting key "${key}"` };
      return checkValue(declaration, value);
    },
  };
  for (const declaration of declarations) registry.register(declaration);
  return registry;
}
