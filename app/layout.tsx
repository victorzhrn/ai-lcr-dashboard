import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ai-lcr dashboard",
  description: "Your LLM requests, costs, and provider failovers — self-hosted.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
