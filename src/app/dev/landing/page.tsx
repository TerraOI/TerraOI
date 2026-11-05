import { notFound } from "next/navigation";
import { LandingPage } from "@/components/site/landing-page";

// Preview of the terraoi.app landing page until host gating (T-130 Task 11, after T-101) puts it
// on "/". Development only: every other environment gets a 404.
export default function DevLandingPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <LandingPage />;
}
