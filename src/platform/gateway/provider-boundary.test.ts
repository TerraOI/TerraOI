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

  it("the scan actually looks at the gateway modules of this slice (a guard that saw nothing is not a guard)", () => {
    const gatewayFiles = repoSource
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((path) => path.startsWith(GATEWAY) && !path.includes(".test."));
    expect(gatewayFiles).toContain(`${GATEWAY}/route.ts`);
    expect(gatewayFiles).toContain(`${GATEWAY}/circuit.ts`);
    expect(gatewayFiles).toContain(`${GATEWAY}/config.ts`);
  });
});
