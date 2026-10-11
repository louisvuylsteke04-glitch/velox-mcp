import { headers } from "next/headers";
import type { ReactNode } from "react";
import { APP_NAME, REPO_URL } from "@/src/branding";
import { PROJECT_INSTRUCTIONS } from "@/src/content/project-instructions";
import { CopyButton } from "./copy-button";

const card = {
  background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14,
  boxShadow: "0 10px 28px rgba(60,50,30,0.06)", overflow: "hidden",
} as const;
const chrome = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
  padding: "10px 18px", background: "var(--chrome)", borderBottom: "1px solid var(--chrome-border)",
  fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg3)",
} as const;

function Step({ n, label, children, delay, action }: { n: number; label: string; children: ReactNode; delay: string; action?: ReactNode }) {
  return (
    <section className={`rise ${delay}`} style={card}>
      <div style={chrome}>
        <span className="mono">{String(n).padStart(2, "0")} · {label}</span>
        {action}
      </div>
      <div style={{ padding: "18px 20px 20px", fontSize: 15, lineHeight: 1.6, color: "var(--fg2)" }}>{children}</div>
    </section>
  );
}

/** The connector URL for this deployment, so the page is right on every host. */
async function connectorUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/mcp`;
}

export default async function Home() {
  const url = await connectorUrl();
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "72px 16px 96px" }}>
      <p className="mono rise" style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--fg3)", margin: "0 0 18px" }}>
        Open source · Free · Nothing stored
      </p>
      <h1 className="rise" style={{ fontSize: 40, lineHeight: 1.08, letterSpacing: "-0.03em", margin: "0 0 18px", fontWeight: 700 }}>
        <span style={{ display: "block" }}>{APP_NAME} is your running coach.</span>
        <span style={{ display: "block", color: "var(--moss)" }}>Inside Claude.</span>
      </h1>
      <p className="rise d1" style={{ fontSize: 17, lineHeight: 1.6, color: "var(--fg2)", margin: "0 0 40px", maxWidth: "52ch" }}>
        Claude reads your Strava, builds a periodised plan from your own training, and adapts it to how your runs actually went.
        {` ${APP_NAME}`} is the engine underneath: training load, paces, race prediction and the safety rules a good coach keeps.
      </p>

      <div style={{ display: "grid", gap: 16 }}>
        <Step n={1} label="Add the connector" delay="d1" action={<CopyButton value={url} />}>
          In Claude, open Settings, then Connectors, and add a custom connector with this URL.
          <code className="mono" style={{ display: "block", marginTop: 12, padding: "10px 12px", background: "var(--paper2)", borderRadius: 8, color: "var(--ink)", fontSize: 13, overflowX: "auto" }}>{url}</code>
        </Step>
        <Step n={2} label="Connect Strava" delay="d2">
          In the same place, connect the Strava connector. Your runs go from Strava to Claude directly. {APP_NAME} only sees the numbers Claude passes it, and keeps none of them.
        </Step>
        <Step n={3} label="Make a Claude Project" delay="d3" action={<CopyButton value={PROJECT_INSTRUCTIONS} />}>
          Create a Project called {APP_NAME} and paste this into its instructions. Your plan lives in this Project as one small file.
          <pre className="mono" style={{ margin: "12px 0 0", padding: "12px 14px", background: "var(--paper2)", borderRadius: 8, color: "var(--ink)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{PROJECT_INSTRUCTIONS}</pre>
        </Step>
        <Step n={4} label="Start" delay="d4">
          In the Project, say <em>Set me up</em>. Claude asks about your goal and your week, reads your last <span className="mono">17</span> weeks of running, and builds your plan.
          After a run, tell it how it went. On Sundays, ask for your weekly review.
        </Step>
      </div>

      <section className="rise d4" style={{ marginTop: 48, fontSize: 14, lineHeight: 1.65, color: "var(--fg2)" }}>
        <h2 style={{ fontSize: 15, margin: "0 0 8px", color: "var(--ink)" }}>Your data</h2>
        <p style={{ margin: 0 }}>
          No accounts, no database, no logs of what you send. {APP_NAME} computes an answer and forgets the question.
          Your plan is yours, in your Project. The code is open under AGPL-3.0, so all of this can be checked.
        </p>
      </section>

      <footer className="mono" style={{ marginTop: 56, paddingTop: 20, borderTop: "1px solid var(--border)", fontSize: 11, letterSpacing: "0.06em", color: "var(--fg3)", display: "flex", gap: 18, flexWrap: "wrap" }}>
        <a href={REPO_URL} style={{ color: "var(--fg2)" }}>Source on GitHub</a>
        <span>Running only, for now</span>
        <span>Never medical advice</span>
      </footer>
    </main>
  );
}
