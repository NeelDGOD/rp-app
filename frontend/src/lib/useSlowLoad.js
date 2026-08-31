import { useEffect, useState } from "react";

// Returns true once `loading` has been true for longer than `delayMs`.
// Used to tell the user the backend is likely waking up from sleep
// (free-tier hosts cold-start) instead of leaving a bare spinner.
export function useSlowLoad(loading, delayMs = 5000) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(t);
  }, [loading, delayMs]);

  return slow;
}
