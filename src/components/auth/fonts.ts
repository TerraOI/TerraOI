import { IBM_Plex_Mono, Inter } from "next/font/google";

// Applied as classNames on the sign-in root; the root layout (T-103) is not touched.
export const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});
