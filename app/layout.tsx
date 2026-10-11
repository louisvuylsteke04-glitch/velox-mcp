import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_NAME } from "@/src/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: `${APP_NAME}. An open-source running coach for Claude.`,
  description: `${APP_NAME} turns Claude into a running coach that reads your Strava and keeps your plan honest. Free, open source, nothing stored.`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
