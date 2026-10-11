"use client";

import { useState } from "react";

/** Copies a value to the clipboard and says so for two seconds. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          // Clipboard blocked: the text stays visible to select by hand.
        }
      }}
      className="mono"
      style={{
        border: "1px solid var(--border)", background: "var(--surface)", color: "var(--fg2)",
        borderRadius: 999, padding: "6px 12px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
