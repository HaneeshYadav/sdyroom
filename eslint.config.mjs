import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const asFlatConfig = (config) => (Array.isArray(config) ? config : config.default);

const eslintConfig = [
  {
    ignores: ["**/.next/**", "**/node_modules/**", "**/coverage/**", "**/test-results/**", "**/playwright-report/**"],
  },
  ...asFlatConfig(nextCoreWebVitals),
  ...asFlatConfig(nextTypescript),
  {
    files: ["app/**/page.tsx", "app/api/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["**/*.tsx", "**/*.jsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "dangerouslySetInnerHTML is banned (PR 21): render text through React children so escaping and the CSP stay in force.",
        },
      ],
    },
  },
];

export default eslintConfig;
