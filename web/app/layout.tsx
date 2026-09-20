import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HashPool",
  description:
    "Infrastructure micro-pools: auditable mining-reward splitting, verified on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
