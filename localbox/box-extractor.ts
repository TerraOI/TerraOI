import { spawn } from "node:child_process";

import {
  type AbortReason,
  type ArtifactInput,
  type BoxExtractorPort as PullLoopExtractor,
  type ExtractorInput,
  type ExtractorResult,
} from "./ocr-pull";

/**
 * Local-box OCR extraction behind an injected port (T-211 PR-3f, plan §13 / F32).
 *
 * The pull loop in `ocr-pull.ts` already turns leased object bytes into a complete/abort. This
 * module is the **engine seam**: bytes in, artifact set or a closed abort reason out — with no
 * npm OCR dependency, no service-role key, and no disk persistence of document bytes.
 *
 * OWNER installs whatever binary they trust and points `OCR_COMMAND` at it. Until that env is set,
 * the default port aborts as `unsupported_document` so the job is not silently completed empty.
 */

export type BoxExtractOk = { ok: true; artifacts: ArtifactInput[] };
export type BoxExtractAbort = { ok: false; abortReason: AbortReason; notes?: string[] };
export type BoxExtractResult = BoxExtractOk | BoxExtractAbort;

/**
 * Engine-level port: media type + version id + bytes. The pull loop adapts this via
 * `asPullLoopExtractor` / `resolveBoxExtractor`.
 */
export interface BoxExtractorPort {
  extract(input: {
    bytes: Uint8Array;
    mediaType: string;
    sourceVersionId: string;
  }): Promise<BoxExtractResult>;
}

export type CommandRunRequest = {
  command: string;
  stdin: Uint8Array;
  timeoutMs: number;
};

export type CommandRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (request: CommandRunRequest) => Promise<CommandRunResult>;

/** Default ceiling for an OWNER-installed OCR binary; long enough for multi-page scans. */
export const DEFAULT_OCR_COMMAND_TIMEOUT_MS = 120_000;

const ABORT_REASONS: readonly AbortReason[] = [
  "abandoned_by_worker",
  "source_revoked",
  "unsupported_document",
  "object_missing",
  "quality_failed",
  "operator_cancel",
  "clearance_refused",
];

function isAbortReason(value: unknown): value is AbortReason {
  return typeof value === "string" && (ABORT_REASONS as readonly string[]).includes(value);
}

/**
 * Always abort. Used when no OWNER engine is configured, and as the fail-closed default.
 */
export function createUnavailableBoxExtractor(
  reason: "unsupported_document" | "quality_failed" = "unsupported_document",
): BoxExtractorPort {
  return {
    async extract() {
      return {
        ok: false,
        abortReason: reason,
        notes: ["ocr_engine_unavailable"],
      };
    },
  };
}

/**
 * Deterministic test double: returns a fixed result regardless of input bytes.
 */
export function createFixedBoxExtractor(result: BoxExtractResult): BoxExtractorPort {
  return {
    async extract() {
      if (result.ok) {
        return { ok: true, artifacts: result.artifacts };
      }
      return {
        ok: false,
        abortReason: result.abortReason,
        ...(result.notes === undefined ? {} : { notes: [...result.notes] }),
      };
    },
  };
}

function parseArtifactRow(value: unknown): ArtifactInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const artifactIndex = row["artifactIndex"];
  const bodyText = row["bodyText"];
  if (typeof artifactIndex !== "number" || !Number.isInteger(artifactIndex) || artifactIndex < 0) {
    return undefined;
  }
  if (typeof bodyText !== "string" || bodyText.length < 1) return undefined;
  const artifact: ArtifactInput = { artifactIndex, bodyText };
  if (row["locator"] !== undefined) {
    if (typeof row["locator"] !== "object" || row["locator"] === null || Array.isArray(row["locator"])) {
      return undefined;
    }
    artifact.locator = row["locator"] as Record<string, unknown>;
  }
  if (row["confidence"] !== undefined) {
    if (typeof row["confidence"] !== "number") return undefined;
    artifact.confidence = row["confidence"];
  }
  if (row["notes"] !== undefined) {
    if (!Array.isArray(row["notes"]) || !row["notes"].every((n) => typeof n === "string")) {
      return undefined;
    }
    artifact.notes = row["notes"] as string[];
  }
  return artifact;
}

function parseEngineStdout(stdout: string): BoxExtractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
  }

  // Accept either `{ artifacts: [...] }` or a bare artifact array.
  let rows: unknown;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (record["ok"] === false) {
      const reason = record["abortReason"];
      if (isAbortReason(reason)) {
        const notes = record["notes"];
        if (notes === undefined) return { ok: false, abortReason: reason };
        if (!Array.isArray(notes) || !notes.every((n) => typeof n === "string")) {
          return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
        }
        return { ok: false, abortReason: reason, notes: notes as string[] };
      }
      return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
    }
    rows = record["artifacts"];
  } else {
    return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
  }

  if (!Array.isArray(rows) || rows.length < 1) {
    return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
  }
  const artifacts: ArtifactInput[] = [];
  for (const row of rows) {
    const artifact = parseArtifactRow(row);
    if (artifact === undefined) {
      return { ok: false, abortReason: "quality_failed", notes: ["ocr_output_malformed"] };
    }
    artifacts.push(artifact);
  }
  return { ok: true, artifacts };
}

/**
 * In-memory stdin → stdout spawn. No temp files; stdout/stderr stay in process memory and are
 * never logged here (document words must not reach a box log).
 */
export function createDefaultCommandRunner(): CommandRunner {
  return ({ command, stdin, timeoutMs }) =>
    new Promise<CommandRunResult>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("ocr_command_timeout"));
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });

      child.stdin?.on("error", () => {
        // Broken pipe after early exit — close handler settles the promise.
      });
      child.stdin?.end(Buffer.from(stdin));
    });
}

export interface CommandBoxExtractorOptions {
  /** Read once per extract; default `() => process.env.OCR_COMMAND`. */
  commandFromEnv?: () => string | undefined;
  /** Injectable process runner; default shells out with stdin bytes only. */
  run?: CommandRunner;
  timeoutMs?: number;
}

/**
 * Shell adapter stub: when `OCR_COMMAND` is unbound → unavailable abort; when bound, invoke the
 * OWNER-installed binary with document bytes on stdin and parse JSON artifacts from stdout.
 */
export function createCommandBoxExtractor(opts: CommandBoxExtractorOptions = {}): BoxExtractorPort {
  const commandFromEnv = opts.commandFromEnv ?? (() => process.env["OCR_COMMAND"]);
  const run = opts.run ?? createDefaultCommandRunner();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OCR_COMMAND_TIMEOUT_MS;

  return {
    async extract(input) {
      const raw = commandFromEnv();
      const command = typeof raw === "string" ? raw.trim() : "";
      if (command.length === 0) {
        return {
          ok: false,
          abortReason: "unsupported_document",
          notes: ["ocr_command_unbound"],
        };
      }

      // mediaType / sourceVersionId are authority for the engine contract; the default shell
      // adapter does not forward them as argv (avoids shell injection). OWNER binaries that need
      // them should read a wrapper script via OCR_COMMAND.
      void input.mediaType;
      void input.sourceVersionId;

      let ran: CommandRunResult;
      try {
        ran = await run({ command, stdin: input.bytes, timeoutMs });
      } catch {
        return {
          ok: false,
          abortReason: "quality_failed",
          notes: ["ocr_command_unavailable"],
        };
      }

      if (ran.exitCode !== 0) {
        return {
          ok: false,
          abortReason: "quality_failed",
          notes: ["ocr_command_failed"],
        };
      }
      return parseEngineStdout(ran.stdout);
    },
  };
}

function sniffMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 5) {
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!);
    if (head.startsWith("%PDF-")) return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  return "application/octet-stream";
}

function mapEngineResult(result: BoxExtractResult): ExtractorResult {
  if (result.ok) {
    return { outcome: "extracted", artifacts: result.artifacts };
  }
  const reason = result.abortReason;
  switch (reason) {
    case "abandoned_by_worker":
    case "source_revoked":
    case "unsupported_document":
    case "object_missing":
    case "quality_failed":
    case "operator_cancel":
    case "clearance_refused":
      return {
        outcome: "unsupported",
        reason,
        ...(result.notes === undefined || result.notes.length === 0
          ? {}
          : { notes: [...result.notes] }),
      };
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Adapt the engine port to the pull-loop injector (`ocr-pull.BoxExtractorPort`).
 */
export function asPullLoopExtractor(engine: BoxExtractorPort): PullLoopExtractor {
  return {
    async extract(input: ExtractorInput): Promise<ExtractorResult> {
      const result = await engine.extract({
        bytes: input.bytes,
        mediaType: sniffMediaType(input.bytes),
        sourceVersionId: input.payload.sourceVersionId,
      });
      return mapEngineResult(result);
    },
  };
}

export interface ResolveBoxExtractorOptions {
  commandFromEnv?: () => string | undefined;
  run?: CommandRunner;
  timeoutMs?: number;
}

/**
 * Production wiring hook: command adapter when `OCR_COMMAND` is set, otherwise unavailable.
 * Returns the pull-loop extractor shape so `createBoxWorkerDeps` can take it directly.
 */
export function resolveBoxExtractor(opts: ResolveBoxExtractorOptions = {}): PullLoopExtractor {
  const commandFromEnv = opts.commandFromEnv ?? (() => process.env["OCR_COMMAND"]);
  const raw = commandFromEnv();
  const bound = typeof raw === "string" && raw.trim().length > 0;
  const engine = bound
    ? createCommandBoxExtractor({
        commandFromEnv,
        ...(opts.run === undefined ? {} : { run: opts.run }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      })
    : createCommandBoxExtractor({ commandFromEnv: () => undefined });
  return asPullLoopExtractor(engine);
}
