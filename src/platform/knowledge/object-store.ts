/**
 * Private-object access port (plan §2 "Objects", §7.2 step 1, §9.2.1).
 *
 * Issue #38 is open on which credential and which bucket own private knowledge objects (Supabase
 * Storage vs an R2 binding, and how an upload is authorized). Nothing in this file pre-empts that:
 * the capture path only ever *reads an object by the key the server issued*, which is the half of
 * the job that verification needs regardless of the answer. When #38 lands, its adapter — signed
 * upload grant, storage read, bounded streaming — implements this same port, and no route or
 * handler changes.
 *
 * A read is always bounded: an object larger than the session's bound is reported, never pulled
 * into memory (plan §7.2 step 2: meter the limits before the expensive work).
 */
export type ObjectReadResult =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "oversize"; sizeBytes: number | null }
  | { status: "missing" };

export interface ObjectStore {
  readBounded(objectRef: string, maxBytes: number): Promise<ObjectReadResult>;
}

/**
 * No storage adapter is wired yet (#38), so the capture path carries `ObjectStore | null`: the
 * route says `storage_unavailable` (503) rather than reaching for a service-role key or a bucket
 * that has not been decided, and never pretending the object was simply missing.
 */
export type ObjectStoreOrUnavailable = ObjectStore | null;
