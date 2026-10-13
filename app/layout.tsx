import type { Metadata } from "next";
import "./globals.css";
import { ReadyToastHost } from "./components/StatusUI";

export const metadata: Metadata = {
  title: "Pulso Ignite",
  description:
    "Dashboard interno de Taquión — consumo de pauta multi-cliente (Meta Ads, Google Ads, LinkedIn Ads).",
  icons: { icon: "/brand/taquion-isotipo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        {children}
        <ReadyToastHost />
      </body>
    </html>
  );
}
