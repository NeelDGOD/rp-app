// The backend stores naive UTC ISO strings (no "Z"), so they must be read as UTC.
export function parseServerDate(value) {
  if (!value) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY = 86400000;

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function relativeTime(value, now = new Date()) {
  const d = parseServerDate(value);
  if (!d) return "";
  const mins = Math.round((now - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (startOfDay(d) === startOfDay(now)) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
}

const GROUPS = ["Today", "This week", "Earlier"];

function recencyGroup(value, now) {
  const d = parseServerDate(value);
  if (!d) return GROUPS[2];
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days <= 0) return GROUPS[0];
  if (days < 7) return GROUPS[1];
  return GROUPS[2];
}

export function groupByRecency(items, now = new Date()) {
  const buckets = new Map(GROUPS.map(g => [g, []]));
  items.forEach(item => buckets.get(recencyGroup(item.updated_at, now)).push(item));
  return GROUPS.map(label => ({ label, items: buckets.get(label) })).filter(g => g.items.length);
}
