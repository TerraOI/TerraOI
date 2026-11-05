import { z } from "zod";

/**
 * Data classes (plan §6.2). Required in M1: every collection carries one, sources inherit it,
 * and everything derived carries the **highest** class among its dependencies. The class drives
 * provider clearance (§12.4), retention and export.
 */
export const DataClass = z.enum(["public", "internal", "client_confidential", "restricted"]);
export type DataClass = z.infer<typeof DataClass>;

const RANK: Record<DataClass, number> = {
  public: 0,
  internal: 1,
  client_confidential: 2,
  restricted: 3,
};

/** Validated rank, so an unvalidated string can never slip into a clearance decision. */
export function dataClassRank(cls: DataClass): number {
  return RANK[DataClass.parse(cls)];
}

/**
 * The class of anything derived from `classes` (plan §6.2, AGENTS.md §4.4).
 * An empty dependency list throws: treating "we don't know" as `public` is how client data
 * reaches an uncleared provider (§12.4, §18.2).
 */
export function maxDataClass(classes: readonly DataClass[]): DataClass {
  let highest: DataClass | undefined;
  for (const cls of classes) {
    const validated = DataClass.parse(cls);
    if (highest === undefined || RANK[validated] > RANK[highest]) highest = validated;
  }
  if (highest === undefined) {
    throw new Error("maxDataClass: refusing to treat a value with no known dependencies as public");
  }
  return highest;
}
