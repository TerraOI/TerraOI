import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AGENTS.md §4.3 / T-115 "Must not edit": **all model calls go through the gateway**, and no
 * provider SDK is installed (the adapters are plain `fetch`). A rule with no test is a rule that
 * gets broken, so this scans the repository for the things that would violate it: an SDK package
 * in the manifest, an SDK import in any source file, and a provider endpoint outside
 * `src/platform/gateway/`.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATEWAY = "src/platform/gateway";

const SDK_PACKAGES = [
  "openai",
  "@openai/agents",
  "@anthropic-ai/sdk",
  "@anthropic-ai/vertex-sdk",
  "@deepseek/api",
  "openrouter-sdk",
  "@google/generative-ai",
  "@google-cloud/vertexai",
  "@aws-sdk/client-bedrock-runtime",
  "ollama",
  "cohere-ai",
  "langchain",
  "@langchain/core",
  "llamaindex",
  "@llama-of-pain/llama",
  "groq-sdk",
  "@mistralai/mistralai",
];

const PROVIDER_ENDPOINT_MARKERS = [
  "chat/completions",
  "/ai/run/",
  "api.anthropic.com",
  "api.openai.com",
  "api.deepseek.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "models/gemini",
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // a planned folder that does not exist yet (workers/, localbox/)
  }
  for (const entry of entries) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".open-next") continue;
      sourceFiles(absolute, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
      acc.push(absolute);
    }
  }
  return acc;
}

const repoSource = [
  ...sourceFiles(join(ROOT, "src")),
  ...sourceFiles(join(ROOT, "workers")),
  ...sourceFiles(join(ROOT, "localbox")),
];

describe("the gateway is the only place a provider is reached (AGENTS.md §4.3)", () => {
  it("no provider SDK is installed in the manifest", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
    for (const sdk of SDK_PACKAGES) {
      expect(installed.has(sdk), `${sdk} must not be a dependency`).toBe(false);
    }
  });

  it("no source file imports a provider SDK", () => {
    const offenders: string[] = [];
    for (const file of repoSource) {
      const text = readFileSync(file, "utf8");
      for (const sdk of SDK_PACKAGES) {
        if (new RegExp(`from\\s+["']${sdk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'/]`).test(text)) {
          offenders.push(`${relative(ROOT, file)} imports ${sdk}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("provider endpoints and the OpenAI-compatible path appear only inside the gateway", () => {
    const offenders: string[] = [];
    for (const file of repoSource) {
      const repoPath = relative(ROOT, file).replaceAll("\\", "/");
      // Inside the gateway these markers are allowed (that is where they belong); everywhere else,
      // including tests, they are a finding — a test fixture that calls a provider directly is
      // exactly the leak this rule is meant to catch.
      if (repoPath.startsWith(GATEWAY)) continue;
      const text = readFileSync(file, "utf8");
      for (const marker of PROVIDER_ENDPOINT_MARKERS) {
        if (text.includes(marker)) offenders.push(`${repoPath} mentions ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no module outside the gateway imports the adapter factories (AGENTS.md §4.3)", () => {
    // **What this guard enforces:** no file outside `src/platform/gateway/` may obtain a *value* from
    // `…/gateway/adapters`, or name `createLocalBoxAdapter` / `createWorkersAiAdapter` at all. Those
    // factories are the only place a provider URL, a secret header and a bare `fetch` meet; importing
    // them from a route or an agent would reach a provider without clearance, without a reservation and
    // without an attempt record, and no other test in this repo would notice.
    //
    // **What it deliberately allows:** a type-only import from that module. `AdapterCallOutcome`,
    // `AdapterCallRequest` and `ProviderFailureKind` are the shapes a caller receives from
    // `callModelGateway`; they cannot construct a request, cannot open a connection and cannot be
    // called. Forbidding them would force a third module for no safety gain, and it would have failed
    // T-115d's test suite for importing a result union — the first thing this guard caught, in a
    // legitimate caller.
    //
    // **What it does not cover, stated so nobody over-trusts it:** it does not stop a caller writing
    // its own `fetch` to a provider. That case is caught only by the endpoint-marker scan above, which
    // is a string match and is evaded by a URL built at runtime. Making this a structural rule (an
    // import-graph check in `scripts/check-structure.mjs`) is a bigger decision than this slice, and no
    // packet owns `scripts/` — so the boundary enforced here is the value-import rule, written as what
    // it is.
    const offenders: string[] = [];
    for (const file of repoSource) {
      const repoPath = relative(ROOT, file).replaceAll("\\", "/");
      if (repoPath.startsWith(GATEWAY)) continue;
      const text = readFileSync(file, "utf8");
      for (const found of adapterModuleRefs(text)) offenders.push(`${repoPath} ${found}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the guard separates a value import from a type-only import, and catches the factory either way", () => {
    // The rule is about capability, not about naming a path. Each line below is a form a real caller
    // could write; the first group must pass, the second must be reported.
    const allowed = [
      'import type { AdapterCallOutcome } from "@/platform/gateway/adapters";',
      'import type { AdapterCallOutcome, ProviderFailureKind } from "@/platform/gateway/adapters";',
      'import type {\n  AdapterCallOutcome,\n} from "@/platform/gateway/adapters";',
      'export type Outcome = import("@/platform/gateway/adapters").AdapterCallOutcome;',
      'type Outcome = import("@/platform/gateway/adapters").AdapterCallOutcome;',
      'import { callModelGateway } from "@/platform/gateway/call";',
      // A whole file, not a snippet: the scan is fed complete files, so a legitimate
      // type-only import next to unrelated imports and a relative re-export must still pass.
      'import { describe, expect, it } from "vitest";\nimport { composeAnswer, type ComposeDeps } from "./compose";\nimport type { AdapterCallOutcome } from "@/platform/gateway/adapters";\nimport { callModelGateway } from "@/platform/gateway/call";\n\ndescribe("compose", () => { it("runs", () => expect(1).toBe(1)); });',
    ];
    for (const source of allowed) {
      expect(adapterModuleRefs(source), `must be allowed: ${source.replace(/\s+/g, " ")}`).toEqual([]);
    }
    const forbidden = [
      'import { createWorkersAiAdapter } from "@/platform/gateway/adapters";',
      'import * as adapters from "@/platform/gateway/adapters";',
      'import { type AdapterCallOutcome, createLocalBoxAdapter } from "@/platform/gateway/adapters";',
      'const adapter = require("@/platform/gateway/adapters").createLocalBoxAdapter;',
      "const factory = adapters.createWorkersAiAdapter;",
      // The dangerous pair: one allowed-looking type import must not make the rest of the
      // file innocent. A classifier that returns [] because it saw a type-only import first
      // would silently open the hole this guard exists to close.
      'import type { AdapterCallOutcome } from "@/platform/gateway/adapters";\nimport { createLocalBoxAdapter } from "@/platform/gateway/adapters";',
      // A value loaded at runtime is a value, with or without a factory name in the text.
      'const adapterModule = await import("@/platform/gateway/adapters");',
    ];
    for (const source of forbidden) {
      expect(adapterModuleRefs(source), `must be reported: ${source.replace(/\s+/g, " ")}`).not.toEqual([]);
    }
  });

  it("the import guard is looking at real text: the factories exist and are named inside the gateway", () => {
    // A guard that matches nothing passes for the wrong reason. These files *do* contain the factory
    // names, and the scan above still returns clean — proof that the pass comes from the boundary, not
    // from a pattern that never matches anything.
    const factories = readFileSync(join(ROOT, GATEWAY, "adapters.ts"), "utf8");
    expect(factories).toContain("createLocalBoxAdapter");
    expect(factories).toContain("createWorkersAiAdapter");
    // And the classifier is not vacuous: it reports the factory names where they appear.
    expect(adapterModuleRefs(factories).length).toBeGreaterThan(0);
    const tests = readFileSync(join(ROOT, GATEWAY, "adapters.test.ts"), "utf8");
    expect(tests).toContain("createWorkersAiAdapter");
  });

  it("the scan actually looks at the gateway modules of this slice (a guard that saw nothing is not a guard)", () => {
    const gatewayFiles = repoSource
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((path) => path.startsWith(GATEWAY) && !path.includes(".test."));
    expect(gatewayFiles).toContain(`${GATEWAY}/route.ts`);
    expect(gatewayFiles).toContain(`${GATEWAY}/circuit.ts`);
    expect(gatewayFiles).toContain(`${GATEWAY}/config.ts`);
    // From 115b the guard also proves it is looking at the place where the real `fetch` calls live.
    expect(gatewayFiles).toContain(`${GATEWAY}/adapters.ts`);
  });
});
