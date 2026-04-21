
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      version: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ["**/*.rules"],
    plugins: {
      "firebase-rules": firebaseRulesPlugin,
      "@firebase/rules": firebaseRulesPlugin,
    },
    rules: {
      "firebase-rules/no-open-reads": "error",
      "firebase-rules/no-open-writes": "error",
    },
  }
);
