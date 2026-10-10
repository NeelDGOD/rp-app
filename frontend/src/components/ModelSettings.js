import React, { useReducer } from "react";
import ModelChain from "./ModelChain";
import ProviderKeys from "./ProviderKeys";

// The model order list plus the API keys it uses. Used in Settings and in the in-chat popup.
export default function ModelSettings() {
  const [, refresh] = useReducer(n => n + 1, 0);

  return (
    <div className="model-settings">
      <ModelChain />
      <ProviderKeys onChange={refresh} />
    </div>
  );
}
