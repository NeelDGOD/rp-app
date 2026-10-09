// Versions of a reply, worked out from the contents of every saved branch of a chat.
//
// Each branch is a full copy of the conversation. A retry and an edit-and-resend both end up as
// another copy that shares the conversation up to some turn and differs from there on. So instead
// of trusting how branches were linked when they were created, the versions of a turn are simply:
// every branch whose conversation before that turn is identical to the one on screen, and that
// has a reply at that position. Retries and edits therefore land in one list, and each version
// carries its own user message and its own future (the rest of its branch).

const sameMessage = (a, b) => a.role === b.role && a.content === b.content;

// Messages shared with `other` starting after index 0 (the system card is rewritten on every send).
function sharedPrefix(history, other) {
  let i = 1;
  while (i < history.length && i < other.length && sameMessage(history[i], other[i])) i++;
  return i - 1;
}

const turnKey = (user, assistant) => `${user.content}\u0000${assistant.content}`;

// Map<visibleMessageIndex, { versions: [{ branch, user, assistant }], current }> with one entry per
// assistant reply that has two or more versions. `branch` is the one to switch to: the version
// itself if it is on screen, otherwise the most recently used branch that has that exact turn
// (the future you were last in). Versions are numbered oldest first, so numbers never shuffle.
export function buildVersionMap(active, branches) {
  const result = new Map();
  if (!active || branches.length < 2) return result;

  const history = active.history;
  const candidates = [active, ...branches.filter(b => b.id !== active.id)];
  const shared = new Map(candidates.map(b => [b.id, b === active ? Infinity : sharedPrefix(history, b.history)]));

  let visible = -1;
  history.forEach((message, k) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    visible += 1;
    if (message.role !== "assistant" || k < 2 || history[k - 1].role !== "user") return;

    const turns = new Map();
    candidates.forEach((branch, order) => {
      const h = branch.history;
      if (shared.get(branch.id) < k - 2 || h.length <= k || h[k].role !== "assistant" || h[k - 1].role !== "user") return;
      const key = turnKey(h[k - 1], h[k]);
      if (!turns.has(key)) turns.set(key, { user: h[k - 1], assistant: h[k], branches: [], order });
      turns.get(key).branches.push(branch);
    });
    if (turns.size < 2) return;

    const activeKey = turnKey(history[k - 1], history[k]);
    const entries = [...turns.entries()].map(([key, turn]) => {
      const oldest = turn.branches.reduce((min, b) => ((b.created_at || "") < min ? b.created_at || "" : min), turn.branches[0].created_at || "");
      const latest = turn.branches.reduce((best, b) => ((b.updated_at || "") > (best.updated_at || "") ? b : best));
      return { key, user: turn.user, assistant: turn.assistant, order: turn.order, oldest, branch: turn.branches.includes(active) ? active : latest };
    });
    entries.sort((a, b) => (a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : a.order - b.order));

    result.set(visible, {
      versions: entries.map(({ branch, user, assistant }) => ({ branch, user, assistant })),
      current: entries.findIndex(e => e.key === activeKey),
    });
  });
  return result;
}

// Versions that carry on from the end of the conversation on screen: branches that contain all of it
// and have another turn after it. They appear after Undo (the branch you are on is then shorter than
// the others), and without this they would be unreachable. Same shape as a version entry, oldest first;
// `branch` is the most recently used branch with that exact next turn.
export function buildFutures(active, branches) {
  if (!active) return [];
  const history = active.history;
  // Undoing a chat's first turn leaves an empty history (the hidden character card goes too).
  const end = Math.max(history.length, 1);
  if (end > 1 && history[end - 1].role !== "assistant") return [];

  const turns = new Map();
  branches.forEach((branch, order) => {
    const h = branch.history;
    if (branch.id === active.id || h.length < end + 2 || sharedPrefix(history, h) < end - 1) return;
    if (h[end].role !== "user" || h[end + 1].role !== "assistant") return;
    const key = turnKey(h[end], h[end + 1]);
    if (!turns.has(key)) turns.set(key, { user: h[end], assistant: h[end + 1], branches: [], order });
    turns.get(key).branches.push(branch);
  });

  return [...turns.values()]
    .map(t => ({
      user: t.user,
      assistant: t.assistant,
      order: t.order,
      oldest: t.branches.reduce((min, b) => ((b.created_at || "") < min ? b.created_at || "" : min), t.branches[0].created_at || ""),
      branch: t.branches.reduce((best, b) => ((b.updated_at || "") > (best.updated_at || "") ? b : best)),
    }))
    .sort((a, b) => (a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : a.order - b.order))
    .map(({ branch, user, assistant }) => ({ branch, user, assistant }));
}
