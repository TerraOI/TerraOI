import { Inter } from "next/font/google";

// Its .variable class goes on the sign-in root (defining --font-sans for the CSS module);
// the root layout (T-103) is not touched. Add IBM Plex Mono here when a screen shows data.
export const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
