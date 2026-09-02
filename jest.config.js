/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  // bcrypt.hash at cost 10 can take >5s under CPU contention across parallel
  // workers; the jest default 5000ms timeout was killing tests mid-await.
  testTimeout: 30000,
  // Keep the TypeScript transform fast and tolerant of the existing relaxed
  // compiler settings (noImplicitAny is already false in tsconfig).
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
