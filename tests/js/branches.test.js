// Tests for frontend/src/lib/branches.js against REAL chat data produced by the backend (fixtures.json).
// Run: tests/js/run.sh   (bundles with esbuild, runs with node:test)
import test from "node:test";
import assert from "node:assert/strict";
import { buildVersionMap, buildFutures } from "../../frontend/src/lib/branches.js";
import fixtures from "./fixtures.json";

const chatOf = name => fixtures[name].chat;
const ids = name => fixtures[name].ids;
const branchOf = (name, key) => chatOf(name).branches.find(b => b.id === ids(name)[key]);

function mapFor(name, key) {
  const chat = chatOf(name);
  return buildVersionMap(branchOf(name, key), chat.branches);
}

// readable summary of one entry: [["q1","reply"], ...] and which branch keys the arrows lead to
function describe(name, key, visIdx) {
  const entry = mapFor(name, key).get(visIdx);
  if (!entry) return null;
  const inv = Object.fromEntries(Object.entries(ids(name)).map(([k, v]) => [v, k]));
  return {
    n: entry.versions.length,
    current: entry.current,
    users: entry.versions.map(v => v.user.content),
    targets: entry.versions.map(v => inv[v.branch.id]),
  };
}

const entriesAt = (name, key) => [...mapFor(name, key).keys()];

// ---- 1. plain retries ----------------------------------------------------------------------------
test("retry twice: one list 1/3..3/3, same from every version", () => {
  for (const [key, current] of [["root", 0], ["b2", 1], ["b3", 2]]) {
    const d = describe("retry_twice", key, 1);
    assert.equal(d.n, 3);
    assert.equal(d.current, current);
    assert.deepEqual(d.targets, ["root", "b2", "b3"]);
    assert.deepEqual(entriesAt("retry_twice", key), [1], "only the reply has arrows, not the user message");
  }
});

// ---- 2. two futures from one reply -----------------------------------------------------------------
test("two futures: each version keeps its own conversation", () => {
  // on root: turn 1 has two versions (root's reply vs b2's reply); root's own later turn has a retry (b4)
  let d = describe("two_futures", "root", 1);
  assert.equal(d.n, 2); assert.equal(d.current, 0);
  assert.deepEqual(d.targets, ["root", "b2"]);
  d = describe("two_futures", "root", 3);
  assert.equal(d.n, 2); assert.equal(d.current, 0);
  assert.deepEqual(d.targets, ["root", "b4"]);
  // b2's future (q3, q4) is not mixed into root's later turns
  assert.equal(branchOf("two_futures", "b2").history.filter(m => m.role === "user").length, 3);
  assert.deepEqual(entriesAt("two_futures", "b2"), [1], "b2 only has the shared first turn");
  // from b2, version 1 leads to the most recently used branch that has that exact turn (b4, created last)
  d = describe("two_futures", "b2", 1);
  assert.equal(d.current, 1);
  assert.deepEqual(d.targets, ["b4", "b2"]);
  // from b4 the same turn lists the same two versions, with itself as version 1
  d = describe("two_futures", "b4", 1);
  assert.deepEqual(d.targets, ["b4", "b2"]);
  d = describe("two_futures", "b4", 3);
  assert.equal(d.current, 1);
  assert.deepEqual(d.targets, ["root", "b4"]);
});

// ---- 3/4. the owner's main complaint: retries + edit in ONE continuous list --------------------------------
test("edit after retries: counter continues (4/4) and keeps the older replies", () => {
  for (const [key, current] of [["root", 0], ["b2", 1], ["b3", 2], ["b4", 3]]) {
    const d = describe("edit_after_retries", key, 1);
    assert.equal(d.n, 4, `from ${key}`);
    assert.equal(d.current, current, `from ${key}`);
    assert.deepEqual(d.targets, ["root", "b2", "b3", "b4"]);
    assert.deepEqual(d.users, ["q1", "q1", "q1", "q1 (edited)"], "each version keeps its own user message");
  }
});

test("retry after an edit: 5/5, nothing restarts at 1", () => {
  for (const [key, current] of [["root", 0], ["b3", 2], ["b4", 3], ["b5", 4]]) {
    const d = describe("retry_after_edit", key, 1);
    assert.equal(d.n, 5, `from ${key}`);
    assert.equal(d.current, current, `from ${key}`);
    assert.deepEqual(d.targets, ["root", "b2", "b3", "b4", "b5"]);
    assert.deepEqual(d.users, ["q1", "q1", "q1", "q1 (edited)", "q1 (edited)"]);
  }
});

// ---- 5. several fork points in one chat ----------------------------------------------------------------------
test("multiple fork points: arrows only where versions exist, per position", () => {
  // root view: turn 2 splits (original vs edited), turn 4 splits (original vs retry); turns 1 and 3 do not
  assert.deepEqual(entriesAt("multi_fork", "root"), [3, 7]);
  let d = describe("multi_fork", "root", 3);
  assert.equal(d.n, 2); assert.deepEqual(d.users, ["turn 2", "turn 2 (edited)"]);
  d = describe("multi_fork", "root", 7);
  assert.equal(d.n, 2); assert.equal(d.current, 0);
  // edited path view: turn 2 shows it as version 2, and its own later turn has its own versions
  assert.deepEqual(entriesAt("multi_fork", "b2"), [3, 5]);
  d = describe("multi_fork", "b2", 3);
  assert.equal(d.current, 1);
  d = describe("multi_fork", "b2", 5);
  assert.equal(d.n, 2); assert.deepEqual(d.users, ["turn 3 on edited path", "turn 3 on edited path (edited again)"]);
  assert.deepEqual(d.targets, ["b2", "b4"]);
});

// ---- 6. undo and in-place edits --------------------------------------------------------------------------------
test("undo removes a version; editing a reply in place never creates one", () => {
  assert.deepEqual(entriesAt("undo_and_edit_message", "root"), []);
  assert.deepEqual(entriesAt("undo_and_edit_message", "b2"), []);
});

// ---- 7. identical copies are not phantom versions --------------------------------------------------------------------
test("a restored bookmark identical to its source shows no arrows", () => {
  assert.deepEqual(entriesAt("duplicates_from_bookmark", "root"), []);
  assert.deepEqual(entriesAt("duplicates_from_bookmark", "restored"), []);
});

// ---- 8. size / speed -----------------------------------------------------------------------------------------------------
test("40 turns x 13 branches is fast and lists every version of the last reply", () => {
  const t0 = performance.now();
  const d = describe("many_branches", "root", 79);
  const ms = performance.now() - t0;
  assert.equal(d.n, 13);
  assert.deepEqual(d.targets, ["root", ...Array.from({ length: 12 }, (_, i) => `r${i}`)]);
  assert.ok(ms < 100, `took ${ms.toFixed(1)}ms`);
  assert.deepEqual(entriesAt("many_branches", "root"), [79], "earlier identical turns have no arrows");
});

// ---- properties that must hold for EVERY branch of EVERY scenario -----------------------------------------------------------
const sameHistory = (a, b) => a.history.length === b.history.length && a.history.every((m, i) => i === 0 || (m.role === b.history[i].role && m.content === b.history[i].content));

test("property: the active version is always in the list at `current`", () => {
  for (const name of Object.keys(fixtures)) {
    for (const branch of chatOf(name).branches) {
      for (const [, entry] of buildVersionMap(branch, chatOf(name).branches)) {
        assert.ok(entry.current >= 0, `${name}`);
        assert.equal(entry.versions[entry.current].branch.id, branch.id, `${name}`);
        assert.ok(entry.versions.length >= 2);
      }
    }
  }
});

// a branch whose messages are just the beginning of another branch holds nothing of its own
const isPrefixOf = (small, big) => small.history.length <= big.history.length
  && small.history.every((m, i) => i === 0 || (m.role === big.history[i].role && m.content === big.history[i].content));

test("property: nothing becomes unreachable (every branch's content can be reached from every other branch using the arrows)", () => {
  for (const name of Object.keys(fixtures)) {
    const { branches } = chatOf(name);
    const byId = new Map(branches.map(b => [b.id, b]));
    for (const start of branches) {
      const seen = new Set([start.id]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift();
        const next = [];
        for (const [, entry] of buildVersionMap(cur, branches)) entry.versions.forEach(v => next.push(v.branch.id));
        buildFutures(cur, branches).forEach(f => next.push(f.branch.id));
        for (const id of next) if (!seen.has(id)) { seen.add(id); queue.push(byId.get(id)); }
      }
      for (const target of branches) {
        const covered = [...seen].some(id => sameHistory(byId.get(id), target) || isPrefixOf(target, byId.get(id)));
        assert.ok(covered, `${name}: branch ${target.id.slice(0, 6)} unreachable from ${start.id.slice(0, 6)}`);
      }
    }
  }
});

// ---- futures: what continues from here (reachability after Undo) ----------------------------------------------------
const futuresOf = (name, key) => {
  const inv = Object.fromEntries(Object.entries(ids(name)).map(([k, v]) => [v, k]));
  return buildFutures(branchOf(name, key), chatOf(name).branches).map(f => ({ branch: inv[f.branch.id], user: f.user.content }));
};

test("after undo, the longer branches are offered as futures", () => {
  assert.deepEqual(futuresOf("undo_prefix", "b2"), [{ branch: "root", user: "q3" }]);
  assert.deepEqual(futuresOf("undo_prefix", "root"), [], "the longer branch has nothing after it");
  assert.deepEqual(futuresOf("undo_and_edit_message", "b2"), [{ branch: "root", user: "q1" }], "even an emptied branch can get back");
});

test("no futures when nothing extends the conversation, or while a message is pending", () => {
  assert.deepEqual(futuresOf("retry_twice", "root"), []);
  assert.deepEqual(futuresOf("duplicates_from_bookmark", "root"), [], "an identical copy is not a future");
  const chat = chatOf("undo_prefix");
  const pending = { ...chat.branches[1], history: [...chat.branches[1].history, { role: "user", content: "typing" }] };
  assert.deepEqual(buildFutures(pending, chat.branches), []);
  assert.deepEqual(buildFutures(null, chat.branches), []);
});

test("property: every future contains the whole conversation on screen", () => {
  for (const name of Object.keys(fixtures)) {
    for (const active of chatOf(name).branches) {
      for (const f of buildFutures(active, chatOf(name).branches)) {
        assert.notEqual(f.branch.id, active.id);
        assert.ok(isPrefixOf(active, f.branch), name);
        assert.ok(f.branch.history.length >= active.history.length + 2, name);
      }
    }
  }
});

test("property: the numbering of a position is the same from every branch that shares it", () => {
  for (const name of Object.keys(fixtures)) {
    const { branches } = chatOf(name);
    for (const a of branches) {
      for (const b of branches) {
        const mapA = buildVersionMap(a, branches);
        const mapB = buildVersionMap(b, branches);
        for (const [idx, entryA] of mapA) {
          const entryB = mapB.get(idx);
          if (!entryB) continue;
          const keysA = entryA.versions.map(v => `${v.user.content}|${v.assistant.content}`);
          const keysB = entryB.versions.map(v => `${v.user.content}|${v.assistant.content}`);
          const sameHere = a.history.slice(1, idx * 0 + 1).length >= 0; // positions are compared only when both have the entry
          assert.ok(sameSet(keysA, keysB) || !sameHere, `${name} position ${idx}`);
          if (sameSet(keysA, keysB)) assert.deepEqual(keysA, keysB, `${name}: order changed at position ${idx}`);
        }
      }
    }
  }
});

function sameSet(x, y) {
  return x.length === y.length && x.every(k => y.includes(k));
}

test("no arrows without 2+ versions, and a single branch is never touched", () => {
  const chat = chatOf("retry_twice");
  assert.equal(buildVersionMap(chat.branches[0], [chat.branches[0]]).size, 0);
  assert.equal(buildVersionMap(null, chat.branches).size, 0);
});

test("an optimistic (not yet saved) active branch is handled via its own history", () => {
  const chat = chatOf("retry_twice");
  const active = { ...chat.branches[1], history: [...chat.branches[1].history, { role: "user", content: "pending" }] };
  const map = buildVersionMap(active, chat.branches);
  assert.equal(map.get(1).versions.length, 3);
  assert.equal(map.get(1).current, 1);
});
