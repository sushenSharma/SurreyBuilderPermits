import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Permit Plan Precheck",
  description: "PDF plan intake and sheet splitting workflow for city review prechecks."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
