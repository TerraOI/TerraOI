import type { Metadata } from "next";
import type { ReactNode } from "react";

import { inter } from "@/components/auth/fonts";

// Per-host product identity is applied by the tenant layout (plan §5.1, F04). This root stays
// TerraOI-named so a customer host never inherits a title from a shared default.
export const metadata: Metadata = {
  title: "TerraOI",
  description: "Operational intelligence platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
