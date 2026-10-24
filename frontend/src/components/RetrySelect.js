import React from "react";
import { normalizeRetries } from "../lib/chain";

const CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10];

// How many times to ask again when a source says it is busy. `compact` is the short form used inside a tile's rows.
export default function RetrySelect({ id, value, onChange, compact = false, label }) {
  const text = n => (compact ? (n === 0 ? "no retries" : n === 1 ? "1 retry" : `${n} retries`) : (n === 0 ? "None, go to the next model" : n === 1 ? "1 retry" : `${n} retries`));
  return (
    <select id={id} className={`input${compact ? " variant-row__retries" : ""}`} value={normalizeRetries(value)} aria-label={label}
      onChange={e => onChange(Number(e.target.value))}>
      {CHOICES.map(n => <option key={n} value={n}>{text(n)}</option>)}
    </select>
  );
}
