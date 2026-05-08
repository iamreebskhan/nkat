/**
 * Jest config for live smoke tests against external AWS endpoints. Opt-in via
 * env (BEDROCK_SMOKE=1, etc). Never run in default CI.
 */
module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/test/smoke'],
  testRegex: '.*\\.smoke\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 60_000,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};
