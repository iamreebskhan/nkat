/**
 * Jest config for integration tests. Uses the same ts-jest transform as the
 * unit-test config but a longer timeout and a separate testRegex so unit
 * runs aren't slowed down by Docker boots.
 */
module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 180_000,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};
