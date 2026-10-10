import React, { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import BottomSheet from "./BottomSheet";
import ModelSettings from "./ModelSettings";
import { PROVIDERS, onSettingsPulled } from "../lib/api";
import { activeRequest } from "../lib/chain";

export default function ModelPickerButton() {
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);

  useEffect(() => onSettingsPulled(() => refresh(n => n + 1)), []);

  const { provider, model, fallbacks } = activeRequest();

  return (
    <>
      <button className="model-chip" onClick={() => setOpen(true)} title="Change the model order and API keys">
        <span className="model-chip__dot" />
        <span className="model-chip__text">
          {PROVIDERS[provider].label} · {model || "no model"}{fallbacks.length > 0 ? ` +${fallbacks.length}` : ""}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <BottomSheet title="Models & API keys" onClose={() => setOpen(false)}>
          <ModelSettings />
        </BottomSheet>
      )}
    </>
  );
}
