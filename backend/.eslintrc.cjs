module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.cjs', 'dist/**'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-floating-promises': 'error',
    'no-console': 'warn',
  },
  overrides: [
    {
      // CLI scripts and test specs are allowed to log freely. Production
      // code uses the Pino logger; these contexts use stdout/stderr by design.
      files: ['scripts/**/*.ts', '**/__tests__/**/*.ts', '**/*.spec.ts', 'test/**/*.ts'],
      rules: {
        'no-console': 'off',
        // Test mocks frequently use `any` to stub Kysely query builders and
        // service shapes — explicit typing here adds friction without value.
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
