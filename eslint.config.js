import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed names are deliberate discards — most often the
      // omit-by-destructuring pattern that strips a field before returning
      // (`const { passwordHash: _hash, ...user } = row`). Without this, the
      // convention the underscore signals is not actually honoured.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
