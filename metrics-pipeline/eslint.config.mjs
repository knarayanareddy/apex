import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".harness/**", ".verification/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.ts"],
    languageOptions: { globals: { console: "readonly", process: "readonly", Buffer: "readonly", setTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", queueMicrotask: "readonly", performance: "readonly" } }
  }
);
