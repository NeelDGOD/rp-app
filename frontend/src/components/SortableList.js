import React, { useEffect, useRef, useState } from "react";

const EDGE = 64;       // px from the edge of the scrolling area where dragging starts to scroll it
const MAX_SPEED = 16;  // px per frame at the very edge

function scrollerOf(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement;
}

// Reorderable list. Each row gets `handle` props to spread on its drag handle: pointer events (mouse and
// touch) drag the row, and the arrow keys move it one place. onMove(from, to) is called once, on drop.
export default function SortableList({ items, getKey, onMove, renderItem }) {
  const nodes = useRef([]);
  const drag = useRef(null);
  const frame = useRef(0);
  const refocus = useRef(null);
  const [view, setView] = useState(null);   // { from, to, dy } while a row is being dragged

  useEffect(() => {
    if (refocus.current == null) return;
    document.querySelector(`[data-sort-handle="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function measure() {
    const d = drag.current;
    const dy = d.lastY - d.startY + (d.scroller.scrollTop - d.startScroll);
    const centre = d.rects[d.from].top + d.rects[d.from].height / 2 + dy;
    d.to = d.rects.filter((r, i) => i !== d.from && r.top + r.height / 2 < centre).length;
    setView({ from: d.from, to: d.to, dy });
  }

  function tick() {
    const d = drag.current;
    if (!d) return;
    const box = d.scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : d.scroller.getBoundingClientRect();
    const fromTop = d.lastY - box.top;
    const fromBottom = box.bottom - d.lastY;
    let speed = 0;
    if (fromTop < EDGE) speed = -MAX_SPEED * (1 - Math.max(fromTop, 0) / EDGE);
    else if (fromBottom < EDGE) speed = MAX_SPEED * (1 - Math.max(fromBottom, 0) / EDGE);
    if (speed) {
      d.scroller.scrollTop += speed;
      measure();
    }
    frame.current = requestAnimationFrame(tick);
  }

  function begin(e, from) {
    if (e.button > 0) return;
    e.preventDefault();
    const rects = items.map((_, i) => nodes.current[i].getBoundingClientRect());
    const scroller = scrollerOf(nodes.current[from]);
    drag.current = {
      from, to: from, rects, scroller, id: e.pointerId,
      startY: e.clientY, lastY: e.clientY, startScroll: scroller.scrollTop,
      gap: rects.length > 1 ? rects[1].top - rects[0].bottom : 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setView({ from, to: from, dy: 0 });
    frame.current = requestAnimationFrame(tick);
  }

  function move(e) {
    if (!drag.current) return;
    drag.current.lastY = e.clientY;
    measure();
  }

  function end(e, commit) {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(frame.current);
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(d.id)) e.currentTarget.releasePointerCapture(d.id);
    setView(null);
    if (commit && d.to !== d.from) {
      refocus.current = getKey(items[d.from]);
      onMove(d.from, d.to);
    }
  }

  const handleProps = i => ({
    "data-sort-handle": getKey(items[i]),
    "aria-label": "Reorder: drag, or use the up and down arrow keys",
    onPointerDown: e => begin(e, i),
    onPointerMove: move,
    onPointerUp: e => end(e, true),
    onPointerCancel: e => end(e, false),
    onKeyDown: e => {
      if (e.key === "Escape" && drag.current) {
        end(e, false);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        refocus.current = getKey(items[i]);
        onMove(i, i + (e.key === "ArrowUp" ? -1 : 1));
      }
    },
  });

  return (
    <div className="sortable" role="list">
      {items.map((item, i) => {
        const dragging = !!view && view.from === i;
        let shift = 0;
        if (view && !dragging) {
          const step = drag.current.rects[view.from].height + drag.current.gap;
          if (view.from < view.to && i > view.from && i <= view.to) shift = -step;
          if (view.from > view.to && i >= view.to && i < view.from) shift = step;
        }
        const style = dragging ? { transform: `translateY(${view.dy}px)` } : shift ? { transform: `translateY(${shift}px)` } : undefined;
        return (
          <div
            key={getKey(item)}
            role="listitem"
            ref={el => { nodes.current[i] = el; }}
            className={`sortable__item${dragging ? " is-dragging" : ""}${view && !dragging ? " is-shifting" : ""}`}
            style={style}
          >
            {renderItem(item, i, handleProps(i), dragging)}
          </div>
        );
      })}
    </div>
  );
}
