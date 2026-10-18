const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "dist/**", ".cache/**", "logs/**", "resources/**"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }]
    }
  },
  {
    files: ["src/main/*Preload.js", "src/main/preload.js"],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ["extensions/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.webextensions } }
  },
  {
    // Renderer files are classic scripts that share one global scope (see index.html).
    files: ["src/renderer/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
    rules: { "no-undef": "off", "no-unused-vars": "off", "prefer-const": "off" }
  }
];
