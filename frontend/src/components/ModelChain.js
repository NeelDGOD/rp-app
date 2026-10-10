import React, { useEffect, useState } from "react";
import { Check, GripVertical, Pencil, Plus, X } from "lucide-react";
import { PROVIDERS, pushSettingsSoon, onSettingsPulled } from "../lib/api";
import { addEntry, moveEntry, readChain, removeEntry, updateEntry, writeChain } from "../lib/chain";
import SortableList from "./SortableList";
import ToggleSetting from "./ToggleSetting";

const hasKey = provider => !!localStorage.getItem(PROVIDERS[provider].tokenKey);
const fallbackOn = () => localStorage.getItem("use_fallbacks") === "true";
const EMPTY_FORM = { provider: "puter", model: "", name: "" };

function SourceSelect({ id, value, onChange }) {
  return (
    <select id={id} className="input" value={value} onChange={e => onChange(e.target.value)}>
      {Object.entries(PROVIDERS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
    </select>
  );
}

export default function ModelChain() {
  const [chain, setChain] = useState(readChain);
  const [useFallbacks, setUseFallbacks] = useState(fallbackOn);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => onSettingsPulled(() => {
    setChain(readChain());
    setUseFallbacks(fallbackOn());
  }), []);

  function commit(next) {
    setChain(next);
    writeChain(next);
    pushSettingsSoon();
  }

  function add(entry) {
    commit(addEntry(chain, entry));
    setForm(f => ({ ...f, model: "", name: "" }));
  }

  const cfg = PROVIDERS[form.provider];

  return (
    <div className="field">
      <div className="field-label">Model order</div>
      <div className="field-hint">
        Tried from the top. If a model fails before it answers, the next one runs. The same source can appear as often as you like,
        each with its own model id.
      </div>

      <ToggleSetting
        label="Fall back to the next model"
        sub="Off: only the first model with a key is used"
        checked={useFallbacks}
        onChange={v => { setUseFallbacks(v); localStorage.setItem("use_fallbacks", String(v)); pushSettingsSoon(); }}
      />

      {chain.length === 0 ? (
        <div className="saved-empty">No models yet. Add one below.</div>
      ) : (
        <SortableList
          items={chain}
          getKey={e => e.id}
          onMove={(from, to) => commit(moveEntry(chain, from, to))}
          renderItem={(e, i, handle) => (
            <div className={`chain-item${editing === e.id ? " is-editing" : ""}`}>
              <div className="chain-item__row">
                <button type="button" className="sort-handle" {...handle}><GripVertical size={18} /></button>
                <span className="chain-item__num">{i + 1}</span>
                <div className="chain-item__text">
                  <span className="chain-item__name">{e.name || e.model || "No model id"}</span>
                  <span className="chain-item__model">{PROVIDERS[e.provider].label}{e.name && e.model ? ` · ${e.model}` : ""}</span>
                  {!hasKey(e.provider) && <span className="chain-item__warn">No {PROVIDERS[e.provider].label} key, so this one is skipped</span>}
                </div>
                <button type="button" className="icon-btn" aria-label={editing === e.id ? "Done editing" : `Edit model ${i + 1}`}
                  onClick={() => setEditing(editing === e.id ? null : e.id)}>
                  {editing === e.id ? <Check size={17} /> : <Pencil size={16} />}
                </button>
                <button type="button" className="icon-btn icon-btn--danger" aria-label={`Remove model ${i + 1}`}
                  onClick={() => commit(removeEntry(chain, e.id))}>
                  <X size={17} />
                </button>
              </div>
              {editing === e.id && (
                <div className="chain-item__edit">
                  <div className="field">
                    <label className="field-label" htmlFor={`src-${e.id}`}>Source</label>
                    <SourceSelect id={`src-${e.id}`} value={e.provider} onChange={provider => commit(updateEntry(chain, e.id, { provider }))} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={`mid-${e.id}`}>Model id</label>
                    <input id={`mid-${e.id}`} className="input input-mono" value={e.model} placeholder={PROVIDERS[e.provider].modelExample}
                      onChange={ev => commit(updateEntry(chain, e.id, { model: ev.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={`nick-${e.id}`}>Nickname (optional)</label>
                    <input id={`nick-${e.id}`} className="input" value={e.name} placeholder="e.g. V4 Pro"
                      onChange={ev => commit(updateEntry(chain, e.id, { name: ev.target.value }))} />
                  </div>
                </div>
              )}
            </div>
          )}
        />
      )}

      <div className="add-model">
        <div className="field-label">Add a model</div>
        <SourceSelect id="add-source" value={form.provider} onChange={provider => setForm(f => ({ ...f, provider }))} />
        {cfg.presets.length > 0 && (
          <div className="preset-row" role="group" aria-label={`${cfg.label} quick picks`}>
            {cfg.presets.map(p => (
              <button key={p.model} type="button" className="chip" onClick={() => add({ provider: form.provider, model: p.model, name: p.label })}>
                <Plus size={14} /> {p.label}
              </button>
            ))}
          </div>
        )}
        <input className="input" placeholder="Nickname (optional)" value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <div className="input-row">
          <input className="input input-mono" placeholder={cfg.modelExample} value={form.model}
            onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
            onKeyDown={e => e.key === "Enter" && form.model.trim() && add(form)} />
          <button type="button" className="btn btn-ghost" disabled={!form.model.trim()} onClick={() => add(form)}>
            <Plus size={16} /> Add
          </button>
        </div>
        <div className="field-hint">{cfg.modelHint}, e.g. <span className="mono">{cfg.modelExample}</span></div>
      </div>
    </div>
  );
}
