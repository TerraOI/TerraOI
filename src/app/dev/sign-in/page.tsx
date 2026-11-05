import { notFound } from "next/navigation";
import { company1Customer, company1Powered, terraoiBrand } from "@/components/auth/fixtures";
import { SignInPage } from "@/components/auth/sign-in-page";
import type { SignInBrand } from "@/components/auth/types";

// Design preview of the T-131 sign-in screens in all three brand modes.
// Development only: every other environment gets a 404, so fixtures never ship as a page.
const MODES: { label: string; brand: SignInBrand }[] = [
  { label: "terraoi", brand: terraoiBrand },
  { label: "powered", brand: company1Powered },
  { label: "customer", brand: company1Customer },
];

async function previewAction() {
  "use server";
}

export default function DevSignInPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <>
      {MODES.map(({ label, brand }) => (
        <section key={label} aria-label={`${label} mode`}>
          <SignInPage
            brand={brand}
            enabledMethods={["microsoft", "magic_link", "password"]}
            status="idle"
            magicLinkAction={previewAction}
            passwordAction={previewAction}
            microsoftHref="#microsoft"
          />
        </section>
      ))}
    </>
  );
}
