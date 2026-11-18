// T-404 acceptance test 3 (rollback rehearsal) and the failure half of test 7, written first.
//
// §17.2's rollback rule, as the packet states it: "Rollback is an app artifact plus an index
// generation, never 'the last deploy'." So this module never guesses a target: it lists versions, and a
// rollback names one that is on that list.
//
// Scope of what runs here: the command is *built and asserted*, never executed against an account. The
// packet limits execution to `--env staging`, plan §20.8 keeps production writes from a development
// machine, and CI has no Cloudflare credentials for a production Worker anyway. `exec` is injected for
// exactly that reason — the tests run with a fake, so a real deploy cannot happen by accident in a test.
import { describe, expect, it } from "vitest";
import {
  assertEnvironmentAllowed,
  assertVersionId,
  listVersions,
  parseDeploymentsList,
  recentVersions,
  rollbackCommand,
  rollbackVersion,
  servingVersionId,
} from "./workers-rollback.mjs";

// Fixture rebuilt from wrangler 4.157.0 `deployments list --json` shape (see workers-sdk
// packages/wrangler/src/__tests__/versions/deployments/deployments.list.test.ts): a top-level
// array of `{ id, created_on, source, strategy, versions: [{ version_id, percentage }] }`.
// Timestamps are on the deployment; versions do not carry created_on or git revision here.
// Every value is synthetic; version ids are UUID-shaped, not real.
const LIST = JSON.stringify([
  {
    id: "d-00000000-0000-4000-8000-000000000001",
    created_on: "2026-11-13T10:00:00.000000Z",
    source: "wrangler",
    strategy: "percentage",
    versions: [{ version_id: "a1000000-0000-4000-8000-000000000001", percentage: 100 }],
  },
  {
    id: "d-00000000-0000-4000-8000-000000000002",
    created_on: "2026-11-14T10:00:00.000000Z",
    source: "wrangler",
    strategy: "percentage",
    versions: [{ version_id: "a2000000-0000-4000-8000-000000000002", percentage: 100 }],
  },
  {
    id: "d-00000000-0000-4000-8000-000000000003",
    created_on: "2026-11-15T10:00:00.000000Z",
    source: "wrangler",
    strategy: "percentage",
    versions: [{ version_id: "a3000000-0000-4000-8000-000000000003", percentage: 100 }],
  },
]);

function fakeExec(output = LIST) {
  const calls = [];
  return {
    calls,
    run: (...args) => {
      calls.push(args);
      return output;
    },
  };
}

describe("listing versions (wrangler 4.157 deployments list --json)", () => {
  it("reads version ids and deployment timestamps from the real top-level array shape", () => {
    const exec = fakeExec();
    const versions = listVersions({ exec: exec.run, wranglerBin: "wrangler" }, "staging");
    expect(exec.calls).toEqual([["wrangler", "deployments", "list", "--env", "staging", "--json"]]);
    expect(versions.map((v) => v.versionId)).toEqual([
      "a3000000-0000-4000-8000-000000000003",
      "a2000000-0000-4000-8000-000000000002",
      "a1000000-0000-4000-8000-000000000001",
    ]);
    expect(versions[0].createdOn).toBe("2026-11-15T10:00:00.000000Z");
    expect(servingVersionId(versions)).toBe("a3000000-0000-4000-8000-000000000003");
  });

  it("keeps the newest first and defaults to the depth the runbook records", () => {
    const exec = fakeExec();
    const versions = listVersions({ exec: exec.run, wranglerBin: "wrangler" }, "staging");
    expect(recentVersions(versions).map((v) => v.versionId)).toHaveLength(3);
    expect(recentVersions(versions, 2)).toHaveLength(2);
  });

  it("refuses to list an environment it has never heard of, rather than returning nothing", () => {
    const exec = fakeExec("[]");
    expect(() => listVersions({ exec: exec.run, wranglerBin: "wrangler" }, "stageing")).toThrowError(/unknown environment/);
    expect(exec.calls).toEqual([]);
  });

  it("refuses an empty listing for a known environment (zero evidence is not success)", () => {
    const exec = fakeExec("[]");
    expect(() => listVersions({ exec: exec.run, wranglerBin: "wrangler" }, "staging")).toThrowError(/empty listing/);
  });

  it("refuses a non-array JSON body for a known environment", () => {
    expect(() => parseDeploymentsList(JSON.stringify({ deployments: [] }), "staging")).toThrowError(/unreadable listing/);
  });
});

describe("choosing a rollback target", () => {
  it("builds wrangler 4 rollback arguments, never as a shell string", () => {
    expect(rollbackCommand({ env: "staging", versionId: "a2000000-0000-4000-8000-000000000002" })).toEqual([
      "wrangler",
      "rollback",
      "a2000000-0000-4000-8000-000000000002",
      "--env",
      "staging",
      "--message",
      "TerraOI runbook rollback (named version id)",
      "--yes",
    ]);
  });

  it("refuses a version id that is not one wrangler would have printed", () => {
    for (const bad of ["", "latest", "current", "a2000000", "--env staging", "a2000000-0000-4000-8000-00000000000x"]) {
      expect(() => assertVersionId(bad), bad).toThrowError(/version id/);
    }
  });

  it("refuses to roll back to a version that is not on the listing", () => {
    const exec = fakeExec();
    expect(() =>
      rollbackVersion({ exec: exec.run, wranglerBin: "wrangler" }, { env: "staging", versionId: "b9000000-0000-4000-8000-000000000009", dryRun: false }),
    ).toThrowError(/not among the listed versions/);
    expect(exec.calls.map((call) => call.slice(0, 3))).toEqual([["wrangler", "deployments", "list"]]);
  });

  it("refuses to roll back to the version already serving, because that deploy would look like a fix", () => {
    const exec = fakeExec();
    expect(() =>
      rollbackVersion({ exec: exec.run, wranglerBin: "wrangler" }, { env: "staging", versionId: "a3000000-0000-4000-8000-000000000003", dryRun: false }),
    ).toThrowError(/already serving/);
    expect(exec.calls.map((call) => call.slice(0, 3))).toEqual([["wrangler", "deployments", "list"]]);
  });

  it("refuses production unless the caller names the owner-only escape explicitly", () => {
    expect(() => assertEnvironmentAllowed("production")).toThrowError(/owner-only/);
    expect(() => assertEnvironmentAllowed("production", { allowProduction: true })).not.toThrow();
    expect(() => assertEnvironmentAllowed("staging")).not.toThrow();
  });
});

describe("dry-run is the default, and the default is what the packet rehearses", () => {
  it("prints the command and touches nothing", () => {
    const exec = fakeExec();
    const r = rollbackVersion({ exec: exec.run, wranglerBin: "wrangler" }, { env: "staging", versionId: "a2000000-0000-4000-8000-000000000002" });
    expect(r.dryRun).toBe(true);
    expect(r.command).toEqual([
      "wrangler",
      "rollback",
      "a2000000-0000-4000-8000-000000000002",
      "--env",
      "staging",
      "--message",
      "TerraOI runbook rollback (named version id)",
      "--yes",
    ]);
    expect(exec.calls.map((call) => call.slice(0, 3))).toEqual([["wrangler", "deployments", "list"]]);
  });

  it("executes once, with exactly the printed arguments, when asked to", () => {
    const exec = fakeExec();
    const r = rollbackVersion({ exec: exec.run, wranglerBin: "wrangler" }, { env: "staging", versionId: "a1000000-0000-4000-8000-000000000001", dryRun: false });
    expect(r.dryRun).toBe(false);
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[1]).toEqual(r.command);
  });

  it("carries no credential material in the arguments it builds (AGENTS §4.6)", () => {
    const command = rollbackCommand({ env: "staging", versionId: "a1000000-0000-4000-8000-000000000001" });
    expect(command.join(" ")).not.toMatch(/token|secret|password|:\/\//i);
  });
});
