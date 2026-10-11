import { APP_NAME, REPO_URL } from "@/src/branding";

const mono = {
  fontFamily: "var(--font-jetbrains-mono, ui-monospace, monospace)",
  fontVariantNumeric: "tabular-nums" as const,
};

/** Placeholder landing page. The full setup guide arrives with M5. */
export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "96px 16px" }}>
      <p style={{ ...mono, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A9082", margin: "0 0 16px" }}>
        Open source. Free. Nothing stored.
      </p>
      <h1 style={{ fontSize: 36, lineHeight: 1.1, letterSpacing: "-0.03em", margin: "0 0 20px" }}>
        <span style={{ display: "block" }}>{APP_NAME} is your running coach.</span>
        <span style={{ display: "block", color: "#5C8B5A" }}>Inside Claude.</span>
      </h1>
      <p style={{ fontSize: 16, lineHeight: 1.6, color: "#6B6357", margin: "0 0 28px" }}>
        Add this server to Claude as a connector, connect Strava, and Claude coaches you with the {APP_NAME} method.
        Your data stays between you, Strava and Claude.
      </p>
      <p style={{ fontSize: 14, color: "#9A9082" }}>
        Setup guide coming soon. Source on <a href={REPO_URL} style={{ color: "#2A2520" }}>GitHub</a>.
      </p>
    </main>
  );
}
