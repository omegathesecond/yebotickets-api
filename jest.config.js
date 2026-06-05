/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  // Keep the TypeScript transform fast and tolerant of the existing relaxed
  // compiler settings (noImplicitAny is already false in tsconfig).
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }],
  },
};
