import type { Metadata } from "next";
import "./globals.css";
import { Web3Provider } from "../providers/Web3Provider";

export const metadata: Metadata = {
  title: "polyterminal",
  description: "BTC-focused Polymarket execution terminal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100">
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
