import React, { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
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
      <button className="model-chip" onClick={() => setOpen(true)} title="Change model and API key">
        <span className="model-chip__dot" />
        <span className="model-chip__text">{PROVIDERS[provider].label} · {model || "no model"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <BottomSheet title="Model & API key" onClose={() => setOpen(false)}>
          <ModelSettings />
        </BottomSheet>
      )}
    </>
  );
}
