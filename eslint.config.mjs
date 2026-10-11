import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The coaching engine must be pure: same input, same output, on any machine,
 * on any day. "Today" is always an explicit argument. No env, no clock, no
 * network, no filesystem, no framework.
 */
const engineIsPure = {
  files: ["src/engine/**/*.ts"],
  rules: {
    "no-restricted-globals": [
      "error",
      { name: "process", message: "Engine code is pure. Pass configuration in as an argument." },
      { name: "fetch", message: "Engine code is pure. No network." },
      { name: "console", message: "Engine code is pure. Return data instead of logging it." },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
        message: "Engine code is pure. Take `today` as an argument instead of Date.now().",
      },
      {
        selector: "NewExpression[callee.name='Date'][arguments.length=0]",
        message: "Engine code is pure. Take `today` as an argument instead of new Date().",
      },
      {
        selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
        message: "Engine code is pure and deterministic. No Math.random().",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["fs", "node:*", "next", "next/*", "react", "mcp-handler", "@modelcontextprotocol/*"], message: "Engine code is pure. No I/O or framework imports." },
          { group: ["**/tools/*", "**/server", "**/app/*"], message: "The engine must not depend on the MCP layer." },
        ],
      },
    ],
  },
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  engineIsPure,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "coverage/**"]),
]);
