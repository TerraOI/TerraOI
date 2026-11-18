import type { Metadata } from "next";
import type { ReactNode } from "react";

import { inter } from "@/components/auth/fonts";

// Root metadata is TerraOI (provider) identity until T-204 applies per-host titles (#65).
// The tenant layout owns branded chrome; it does not yet override document title.
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
