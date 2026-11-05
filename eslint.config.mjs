import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      ".next/**", ".open-next/**", ".wrangler/**", "node_modules/**",
      "archive/**", "docs/**", "brand/terraoi-brand-kit/**",
      "next-env.d.ts", "src/contracts/database.types.ts", "cloudflare-env.d.ts",
    ],
  },
  {
    rules: {
      // Tenancy guardrail (plan §4.1): never read the tenant from a client-supplied header.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='get'][arguments.0.value=/^x-(tenant|org|organisation)/i]",
          message: "Tenant context comes from the verified host resolver, never from a request header (plan §4.1).",
        },
      ],
    },
  },
];

export default config;
