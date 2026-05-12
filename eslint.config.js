import tseslint from "@typescript-eslint/eslint-plugin"
import tsparser from "@typescript-eslint/parser"

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "examples/**/.next/**",
      "examples/**/node_modules/**",
      "examples/**/dist/**",
      "coverage/**",
      "*.tsbuildinfo",
    ],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "e2e/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      // Sensible defaults — be strict on real bugs, lenient on style (prettier owns style).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Source files: console.log is forbidden (use the logger).
    // Exception: sink-edge.ts is THE logger output on Edge runtime.
    files: ["src/**/*.ts"],
    ignores: ["src/sink-edge.ts", "src/gcp.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Tests and e2e can use console for debugging output.
    files: ["test/**/*.ts", "e2e/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]
