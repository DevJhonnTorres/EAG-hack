/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/index.ts"],
  coverageThreshold: {
    global: { branches: 85, functions: 90, lines: 90, statements: 90 },
  },
};
