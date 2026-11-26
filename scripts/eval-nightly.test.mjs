import { describe, expect, it, vi } from "vitest";

import {
  STAGING_READY_FLAGS,
  assessStagingGate,
  main,
  runNightlyEval,
} from "./eval-nightly.mjs";

const allReady = Object.fromEntries(STAGING_READY_FLAGS.map((flag) => [flag, "true"]));

describe("assessStagingGate (#74)", () => {
  it("is ready only when every deploy-staging flag is the string true", () => {
    expect(assessStagingGate(allReady)).toEqual({ ready: true, missing: [] });
  });

  it("lists every missing flag when staging is unprovisioned", () => {
    const gate = assessStagingGate({});
    expect(gate.ready).toBe(false);
    expect(gate.missing).toEqual([...STAGING_READY_FLAGS]);
  });

  it("treats empty and false as missing (never as ready)", () => {
    const gate = assessStagingGate({
      ...allReady,
      HAS_SB_REF: "",
      HAS_CF_TOKEN: "false",
    });
    expect(gate.ready).toBe(false);
    expect(gate.missing).toEqual(["HAS_CF_TOKEN", "HAS_SB_REF"]);
  });
});

describe("runNightlyEval", () => {
  it("returns unavailable without calling the runner when staging is not ready", () => {
    const runEval = vi.fn(() => ({ status: 0 }));
    const outcome = runNightlyEval({}, runEval);
    expect(runEval).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "unavailable",
      reason: "staging secrets are not set (T-004); nightly eval did not run",
      missing: [...STAGING_READY_FLAGS],
    });
  });

  it("runs the eval and surfaces a non-zero exit when staging is ready", () => {
    const runEval = vi.fn(() => ({ status: 7 }));
    expect(runNightlyEval(allReady, runEval)).toEqual({ status: "ran", exitCode: 7 });
    expect(runEval).toHaveBeenCalledOnce();
  });
});

describe("main CLI exit codes", () => {
  it("exits 0 with unavailable when keys are missing (schedule stays green)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main({})).toBe(0);
    expect(log.mock.calls[0]?.[0]).toMatch(/^unavailable:/);
    log.mockRestore();
  });
});
