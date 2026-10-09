import React, { useState, useEffect } from "react";
import BottomSheet from "./BottomSheet";
import ModelSettings from "./ModelSettings";
import { PROVIDERS, currentProvider, onSettingsPulled } from "../lib/api";

export default function ModelPickerButton() {
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);

  useEffect(() => onSettingsPulled(() => refresh(n => n + 1)), []);

  const provider = currentProvider();
  const model = localStorage.getItem(PROVIDERS[provider].modelKey) || PROVIDERS[provider].defaultModel;

  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", verticalAlign: "bottom", padding: 0, border: "none",
        background: "none", color: "inherit", font: "inherit", cursor: "pointer",
      }}>
        {PROVIDERS[provider].label} · {model || "no model"}
      </button>
      {open && (
        <BottomSheet title="Model & API key" onClose={() => setOpen(false)}>
          <ModelSettings />
        </BottomSheet>
      )}
    </>
  );
}
