// Workspace finder rules (T-130). One DNS label: 1-63 chars of a-z, 0-9 and "-", not starting
// or ending with "-". No lookup ever happens: the finder must not reveal which workspaces exist.

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const PASTED_ADDRESS_HINT = "Enter just the first part of your address, like company1.";
export const FORMAT_HINT = "Use lowercase letters, numbers and hyphens, like company1.";

export type WorkspaceUrlResult = { ok: true; url: string } | { ok: false; hint: string };

export function workspaceUrl(input: string): WorkspaceUrlResult {
  const value = input.trim();
  if (SLUG.test(value)) return { ok: true, url: `https://${value}.terraoi.app/` };
  // A dot, slash or colon means someone pasted a full address; tell them which part to keep.
  if (/[./:]/.test(value)) return { ok: false, hint: PASTED_ADDRESS_HINT };
  return { ok: false, hint: FORMAT_HINT };
}
