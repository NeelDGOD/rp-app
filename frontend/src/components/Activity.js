import React from "react";
import { WifiOff } from "lucide-react";
import { useActivity, useOnline } from "../lib/ui";
import { useSlowLoad } from "../lib/useSlowLoad";
import { Spinner } from "./States";

export function ActivityBar() {
  const { pending } = useActivity();
  return <div className={`activity-bar${pending > 0 ? " is-on" : ""}`} aria-hidden="true" />;
}

// Calm, explanatory notice for the free-tier server's cold start, dropped connections and offline.
export function ActivityNotice() {
  const { pending, retrying } = useActivity();
  const online = useOnline();
  const slow = useSlowLoad(pending > 0, 3000);

  if (!online) {
    return (
      <div className="notice notice--warn">
        <WifiOff size={15} />
        <span>You're offline. Nothing can be sent until the connection is back.</span>
      </div>
    );
  }
  if (retrying > 0 || slow) {
    return (
      <div className="notice">
        <Spinner size={14} />
        <span>
          {retrying > 0
            ? "Connection dropped, trying again…"
            : "Waiting on the server. If it was asleep, waking takes up to a minute."}
        </span>
      </div>
    );
  }
  return null;
}
