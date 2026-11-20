"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import type { SignInBrand } from "@/components/auth/types";

import { TenantShell } from "./tenant-shell";

/** Login keeps its own screen. Every other route under the tenant group gets the shell. */
export function TenantFrame({
  brand,
  csrfToken,
  children,
}: {
  brand: SignInBrand;
  csrfToken?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  if (pathname === "/login") return children;
  return (
    <TenantShell brand={brand} csrfToken={csrfToken}>
      {children}
    </TenantShell>
  );
}
