import { INQUIRY_COPY } from "./inquiry-copy";
import { parsePilotInquiry, type PilotInquiry } from "./pilot-inquiry";

// POST /api/pilot-inquiry (T-130). Checks run cheapest first; every outside call is injected so
// the order and the failure mapping are testable without Cloudflare or Postgres.

export interface InquiryDeps {
  isPlatformHost(host: string | null): boolean; // Task 11 supplies the real one
  requestHost(req: Request): string | null;
  verifyTurnstile(token: string, ip: string | null): Promise<boolean>;
  allowRequest(key: string): Promise<boolean>; // rate limiter
  hashIp(ip: string | null): Promise<string>; // 64 lowercase hex
  submit(inquiry: PilotInquiry, ipHash: string): Promise<void>;
}

export const MAX_BODY_BYTES = 8192;

export { INQUIRY_COPY };

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Reads at most `limit` bytes; returns null as soon as the body is larger. */
async function readCapped(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export async function handlePilotInquiry(req: Request, deps: InquiryDeps): Promise<Response> {
  // 1. Host and Origin: cheap header checks, no I/O.
  const host = deps.requestHost(req);
  if (!host || !deps.isPlatformHost(host)) return reply(404);
  if (req.headers.get("origin") !== `https://${host}`) return reply(403);

  // 2. Content type and size.
  if (!isJson(req.headers.get("content-type"))) return reply(415);
  const bytes = await readCapped(req, MAX_BODY_BYTES);
  if (!bytes) return reply(413);

  // 3. Schema. Field messages are fixed text and never echo input.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return reply(400, { fieldErrors: { form: INQUIRY_COPY.checkForm } });
  }
  const parsed = parsePilotInquiry(body);
  if (!parsed.ok) return reply(400, { fieldErrors: parsed.fieldErrors });

  // 4-6. Outside services. Any unexpected failure is the same generic 503; details stay server-side.
  const ip = req.headers.get("cf-connecting-ip");
  try {
    if (!(await deps.verifyTurnstile(parsed.turnstileToken, ip))) {
      return reply(400, { error: INQUIRY_COPY.verificationFailed });
    }
    const ipHash = await deps.hashIp(ip); // the raw IP goes no further than this line
    if (!(await deps.allowRequest(ipHash))) return reply(429, { error: INQUIRY_COPY.rateLimited });
    await deps.submit(parsed.inquiry, ipHash);
  } catch {
    return reply(503, { error: INQUIRY_COPY.unavailable });
  }

  // 7. Done.
  return reply(201, { status: "received" });
}
