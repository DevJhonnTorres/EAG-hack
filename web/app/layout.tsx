import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HashPool",
  description:
    "Micro-pools de infraestructura: reparto de ganancias de mineria auditable, verificado on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
