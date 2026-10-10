import React from "react";

export default function ToggleSetting({ label, sub, checked, onChange }) {
  return (
    <div className="setting">
      <div>
        <div className="setting__label">{label}</div>
        <div className="setting__sub">{sub}</div>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={checked} aria-label={label} onChange={e => onChange(e.target.checked)} />
        <div className="toggle-track" />
        <div className="toggle-thumb" />
      </label>
    </div>
  );
}
