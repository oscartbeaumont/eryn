import cloudflare from "@cloudflare/oxlint-config";
import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

/**
 * Rules the Cloudflare preset enables for React. This repository renders with
 * Solid, so the React rules either do not apply or inspect the wrong semantics.
 */
const reactRulesOff = Object.fromEntries(
  Object.keys(cloudflare.rules ?? {})
    .filter((rule) => rule.startsWith("react/") || rule === "@nkzw/require-use-effect-arguments")
    .map((rule) => [rule, "off"]),
);

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.cloudflare/**",
    "**/.wrangler/**",
    "**/test-results/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
  ],
  // Plugins replaces oxlint's default set, so the preset list is kept and the
  // Effect rules are added to it.
  plugins: [...(cloudflare.plugins ?? []), "effecttsgo"],
  rules: {
    ...cloudflare.rules,
    ...reactRulesOff,
    ...recommended.rules,
    "typescript/no-explicit-any": "error",
    // The program parses untrusted input at its boundaries. Every narrowing
    // assertion there carries a SAFETY comment naming the invariant, which the
    // rule cannot evaluate; the previous anti-slop preset enforced those
    // comments instead.
    "typescript/no-unsafe-type-assertion": "off",
    // Every flagged spread is a plain JSON record, not a class instance; the
    // type-aware rule cannot distinguish the two here.
    "typescript/no-misused-spread": "off",
    // instanceof is used for exact local/SDK classes and platform objects
    // (URL, Response, FormData), never for Effect failures or Error.
    "@nkzw/no-instanceof": "off",
    // The repository writes single-statement blocks without braces and plain
    // array types. Both rules would rewrite the whole codebase without
    // changing behaviour, so the project style wins.
    curly: "off",
    "typescript/array-type": "off",
    "unicorn/numeric-separators-style": "off",
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // The Workers stream reader is untyped in this project, so every read is
      // any. The values are checked before use.
      files: ["src/session/attachments.ts"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
    {
      // The landing site is a second TypeScript project (`tsconfig.landing.json`)
      // that the type-aware linter does not load, so its type information is
      // unreliable. Type checking still covers it.
      files: ["src/landing/**"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
    {
      // `node:test` registers its cases through returned promises instead of
      // awaiting them, and assertions deliberately inspect error instances.
      files: ["**/*.test.ts"],
      rules: {
        "typescript/no-floating-promises": "off",
        "@nkzw/no-instanceof": "off",
      },
    },
  ],
});
