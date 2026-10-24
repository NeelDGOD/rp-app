import React, { useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { addVariant, moveVariant, removeVariant, updateVariant } from "../lib/chain";
import RetrySelect from "./RetrySelect";
import SortableList from "./SortableList";

// The ordered ids inside one tile (one model): reorder them, switch any off, change or remove them, set each one's
// retries, add more.
export default function VariantList({ entry, chain, commit, example, showRetries }) {
  const [draft, setDraft] = useState("");

  function add() {
    if (!draft.trim()) return;
    commit(addVariant(chain, entry.id, draft));
    setDraft("");
  }

  return (
    <div className="field">
      <div className="field-label">Ids that serve this model, tried top to bottom</div>
      <SortableList
        items={entry.variants}
        getKey={v => v.id}
        onMove={(from, to) => commit(moveVariant(chain, entry.id, from, to))}
        renderItem={(v, i, handle) => (
          <div className={`variant-row${v.enabled ? "" : " is-off"}`}>
            <button type="button" className="sort-handle sort-handle--small" {...handle}><GripVertical size={16} /></button>
            <span className="chain-item__num">{i + 1}</span>
            <input type="checkbox" className="variant-row__on" checked={v.enabled} aria-label={`Use ${v.model}`}
              onChange={ev => commit(updateVariant(chain, entry.id, v.id, { enabled: ev.target.checked }))} />
            <input className="input input-mono variant-row__model" value={v.model} aria-label={`Model id ${i + 1}`}
              onChange={ev => commit(updateVariant(chain, entry.id, v.id, { model: ev.target.value }))} />
            {showRetries && (
              <RetrySelect compact value={v.retries} label={`Retries for ${v.model}`}
                onChange={retries => commit(updateVariant(chain, entry.id, v.id, { retries }))} />
            )}
            <button type="button" className="icon-btn icon-btn--danger" aria-label={`Remove ${v.model}`}
              onClick={() => commit(removeVariant(chain, entry.id, v.id))}>
              <X size={16} />
            </button>
          </div>
        )}
      />
      <div className="input-row">
        <input className="input input-mono" placeholder={example} value={draft} aria-label="Add another id for this model"
          onChange={ev => setDraft(ev.target.value)} onKeyDown={ev => ev.key === "Enter" && add()} />
        <button type="button" className="btn btn-ghost" disabled={!draft.trim()} onClick={add}><Plus size={16} /> Add</button>
      </div>
      {showRetries && <div className="field-hint">Retries: how many times that id asks again when its source is busy, waiting 1, 2, 4, 8, then 15 seconds, before the next id in the tile.</div>}
    </div>
  );
}
