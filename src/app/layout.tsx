import type { Metadata } from "next";
import type { ReactNode } from "react";

// Tenant branding is resolved server-side per host (plan §5.1, F04) once T-101/T-103 land.
// Until then this shell is TerraOI-owned and shows no tenant data.
export const metadata: Metadata = {
  title: "TerraOI",
  description: "Operational intelligence platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
