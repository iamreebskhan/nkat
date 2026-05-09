/**
 * Strict UUID v1-v5 validator. Used at trust boundaries (auth, RLS,
 * external input) before we ever interpolate a string into SQL.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function assertUuid(value: unknown, name = 'value'): string {
  if (!isUuid(value)) {
    throw new Error(`${name} is not a valid UUID`);
  }
  return value;
}
