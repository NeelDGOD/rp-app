import React, { useEffect } from "react";

export default function BottomSheet({ title, onClose, children }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div className="sheet-handle" />
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
