import Link from "next/link";

/**
 * Tenant admin hub (T-202 PR-2, plan §15.0 Thin).
 *
 * Writes go through `createAdminRpcClient` → `withTenantRpc` (FAQ-0011). This page is the
 * navigation shell; members / projects / collections forms land in follow-up slices.
 */
export const dynamic = "force-dynamic";

export default function AdminHubPage() {
  return (
    <section>
      <h1>Workspace admin</h1>
      <p>Invite people, grant roles, create projects and collections for this workspace.</p>
      <nav aria-label="Admin sections">
        <ul>
          <li>
            <Link href="/admin/members">Members and roles</Link>
          </li>
          <li>
            <Link href="/admin/projects">Projects</Link>
          </li>
          <li>
            <Link href="/admin/collections">Collections</Link>
          </li>
        </ul>
      </nav>
    </section>
  );
}
