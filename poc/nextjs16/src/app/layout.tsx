import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "POC Next.js 16",
  description: "Le SSO x-core dans un seul process Next, avec des Server Actions",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  );
}
