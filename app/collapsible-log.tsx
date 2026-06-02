"use client";

import { Children, useState, type ReactNode } from "react";

// Caps a long log to `initial` rows and reveals more in `step`-sized chunks,
// so a busy window (e.g. dozens of failovers) doesn't stretch the page forever.
// Lines are server-rendered and passed in as children; only the toggle is client.
export function CollapsibleLog({
  children,
  initial = 20,
  step = 30,
}: {
  children: ReactNode;
  initial?: number;
  step?: number;
}) {
  const all = Children.toArray(children);
  const [visible, setVisible] = useState(initial);
  const shown = all.slice(0, visible);
  const remaining = all.length - shown.length;
  const expanded = visible > initial;

  return (
    <>
      <div className="log">{shown}</div>
      {(remaining > 0 || expanded) && (
        <div className="log-more">
          <span className="muted" style={{ padding: 0 }}>
            showing {shown.length} of {all.length}
          </span>
          <div className="log-more-actions">
            {remaining > 0 && (
              <button
                className="pill"
                onClick={() => setVisible((v) => v + step)}
              >
                View {Math.min(step, remaining)} more
              </button>
            )}
            {expanded && (
              <button className="pill" onClick={() => setVisible(initial)}>
                Collapse
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
