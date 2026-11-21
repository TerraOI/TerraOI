import { Inter } from "next/font/google";

// Its .variable class goes on the sign-in root and the root layout (defining --font-sans).
// Add IBM Plex Mono here when a screen shows data.
export const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
