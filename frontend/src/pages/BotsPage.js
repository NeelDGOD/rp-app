import React, { useEffect, useState, useCallback } from "react";
import { ChevronLeft, Feather, PenLine, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/time";
import { useBusy, useConfirmTap } from "../lib/ui";
import { BusyIcon, EmptyState, ErrorState, ListSkeleton, PageHeader, Spinner } from "../components/States";
import { useToast } from "../components/Toast";

const wordCount = text => (text.trim() ? text.trim().split(/\s+/).length : 0);

export default function BotsPage() {
  const [bots, setBots]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | bot object
  const [name, setName]     = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [busy, runBusy] = useBusy();
  const { armed, confirm } = useConfirmTap();

  const load = useCallback(async () => {
    try { setBots(await api.getBots()); setLoadError(""); }
    catch (e) { setLoadError(e.message); toast(e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew() { setName(""); setContent(""); setEditing("new"); }
  function openEdit(b) { setName(b.name); setContent(b.content); setEditing(b); }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await api.createBot({ name: name.trim(), content });
        toast("Bot created", "success");
      } else {
        await api.updateBot(editing.id, { name: name.trim(), content });
        toast("Saved", "success");
      }
      await load(); setEditing(null);
    } catch (e) { toast(e.message, "error"); }
    finally { setSaving(false); }
  }

  async function deleteBot(id) {
    try { await api.deleteBot(id); await load(); setEditing(null); toast("Bot deleted", "info"); }
    catch (e) { toast(e.message, "error"); }
  }

  // ── Editor view ──
  if (editing !== null) {
    const isNew = editing === "new";
    return (
      <div className="page page--flex">
        <header className="bar">
          <div className="col bar__inner">
            <button className="icon-btn bar__back" onClick={() => setEditing(null)} aria-label="Back to bots">
              <ChevronLeft size={22} />
            </button>
            <div className="bar__title">
              <div className="bar__name">{isNew ? "New character" : "Edit character"}</div>
            </div>
            {!isNew && (
              <button
                className={`btn btn-sm ${armed === editing.id ? "btn-danger is-armed" : "btn-quiet"}`}
                onClick={() => confirm(editing.id, () => runBusy("delete", () => deleteBot(editing.id)))}
                disabled={!!busy || saving}
              >
                <BusyIcon busy={busy === "delete"} Icon={Trash2} size={15} /> {busy === "delete" ? "Deleting…" : armed === editing.id ? "Confirm" : "Delete"}
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !!busy || !name.trim()}>
              {saving ? <><Spinner size={13} /> Saving…</> : "Save"}
            </button>
          </div>
        </header>
        <div className="col editor">
          <input className="title-input" placeholder="Character name" aria-label="Character name" value={name}
            onChange={e => setName(e.target.value)} autoFocus={isNew} />
          <textarea className="input card-textarea" aria-label="Character card"
            placeholder="Paste or write the character card: personality, appearance, backstory, how they speak…"
            value={content} onChange={e => setContent(e.target.value)} />
          <div className="editor__foot">
            <span>{content.length.toLocaleString()} characters</span>
            <span>~{wordCount(content).toLocaleString()} words</span>
          </div>
        </div>
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="page">
      <PageHeader title="Bots" kicker={!loading && bots.length > 0 ? `${bots.length} ${bots.length === 1 ? "character" : "characters"}` : null}>
        <button className="btn btn-ghost btn-sm" onClick={openNew}><Plus size={16} /> New character</button>
      </PageHeader>

      <div className="col">
        {loading && <ListSkeleton rows={3} />}

        {!loading && loadError && bots.length === 0 && (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); load(); }} />
        )}

        {!loading && !loadError && bots.length === 0 && (
          <EmptyState
            icon={Feather}
            title="No characters yet"
            text="Write or paste a character card to start a story with them."
            action={<button className="btn btn-primary" onClick={openNew}><Plus size={17} /> New character</button>}
          />
        )}

        {bots.length > 0 && (
          <div className="cards stagger">
            {bots.map((b, i) => (
              <article key={b.id} className="card" style={{ "--i": i }}>
                <button className="card__main" onClick={() => openEdit(b)}>
                  <span className="card__name">{b.name}</span>
                  <span className="card__excerpt">{b.content || "No card text yet."}</span>
                </button>
                <div className="card__foot">
                  <span className="card__meta">{wordCount(b.content).toLocaleString()} words · {relativeTime(b.updated_at)}</span>
                  <button className="icon-btn" onClick={() => openEdit(b)} aria-label={`Edit ${b.name}`}>
                    <PenLine size={16} />
                  </button>
                  <button
                    className={armed === b.id ? "btn btn-sm btn-danger is-armed" : "icon-btn icon-btn--danger"}
                    onClick={() => confirm(b.id, () => runBusy(`delete-${b.id}`, () => deleteBot(b.id)))}
                    disabled={!!busy}
                    aria-label={armed === b.id ? `Confirm delete ${b.name}` : `Delete ${b.name}`}
                  >
                    {armed === b.id && busy !== `delete-${b.id}` ? "Delete?" : <BusyIcon busy={busy === `delete-${b.id}`} Icon={Trash2} />}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
