import { z } from "zod";

/** Response of GET /api/health. Must never include tenant, user or provider details. */
export const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("terraoi-web"),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponse>;
