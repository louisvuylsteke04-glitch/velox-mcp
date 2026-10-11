import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_NAME } from "@/src/branding";

export const metadata: Metadata = {
  title: `${APP_NAME}. An open-source running coach for Claude.`,
  description: `${APP_NAME} turns Claude into a running coach that reads your Strava and keeps your plan honest. Free, open source, nothing stored.`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F7F3EC", color: "#2A2520", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
