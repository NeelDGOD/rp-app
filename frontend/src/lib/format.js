import React from "react";

// Renders stored message text as typeset prose without ever changing the text itself.
// Roleplay mode: *stage actions* → .act, "dialogue" / “dialogue” → .say.
// Spans never cross a paragraph break, and an opener with no closer yet (mid-stream)
// is left as plain text, so streaming output never flickers or loses characters.

const QUOTE_PAIRS = { '"': '"', "“": "”" };
const isSpace = ch => ch === undefined || /\s/.test(ch);

function runLength(text, i, ch) {
  let n = 0;
  while (text[i + n] === ch) n++;
  return n;
}

// Finds a closing asterisk run for an emphasis opened just before `from`.
function findStarClose(text, from) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "*" && !isSpace(text[j - 1]) && j > from) return j;
  }
  return -1;
}

function parseStars(text, wrap) {
  const out = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "*") {
      const run = runLength(text, i, "*");
      const start = i + run;
      if (!isSpace(text[start])) {
        const end = findStarClose(text, start);
        if (end !== -1) {
          if (buf) { out.push(buf); buf = ""; }
          out.push(wrap(text.slice(start, end), out.length));
          i = end + runLength(text, end, "*");
          continue;
        }
      }
      buf += text.slice(i, start);
      i = start;
      continue;
    }
    buf += text[i];
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

function parseRoleplay(text) {
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "*") {
      const run = runLength(text, i, "*");
      const start = i + run;
      if (!isSpace(text[start])) {
        const end = findStarClose(text, start);
        if (end !== -1) {
          flush();
          out.push(<span key={out.length} className="act">{text.slice(start, end)}</span>);
          i = end + runLength(text, end, "*");
          continue;
        }
      }
      buf += text.slice(i, start);
      i = start;
      continue;
    }

    const closer = QUOTE_PAIRS[ch];
    if (closer) {
      const end = text.indexOf(closer, i + 1);
      if (end !== -1) {
        flush();
        const inner = parseStars(text.slice(i, end + 1), (t, k) => <em key={k}>{t}</em>);
        out.push(<span key={out.length} className="say">{inner}</span>);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function parsePlain(text) {
  return parseStars(text, (t, k) => <em key={k}>{t}</em>);
}

function parsePlainWithBold(text) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return parts.flatMap((part, k) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return [<strong key={`b${k}`}>{part.slice(2, -2)}</strong>];
    if (/^`[^`]+`$/.test(part)) return [<code key={`c${k}`}>{part.slice(1, -1)}</code>];
    return part ? parsePlain(part).map((n, j) => (typeof n === "string" ? n : React.cloneElement(n, { key: `e${k}-${j}` }))) : [];
  });
}

function splitBlocks(text, allowCode) {
  if (!allowCode) return text.split(/\n{2,}/).map(t => ({ type: "p", text: t }));
  const blocks = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text))) {
    text.slice(last, m.index).split(/\n{2,}/).forEach(t => t.trim() && blocks.push({ type: "p", text: t.replace(/^\n+|\n+$/g, "") }));
    blocks.push({ type: "code", text: m[1].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  text.slice(last).split(/\n{2,}/).forEach((t, idx, arr) => {
    if (t.trim() || (idx === arr.length - 1 && blocks.length === 0)) blocks.push({ type: "p", text: t.replace(/^\n+/, "") });
  });
  return blocks;
}

export function renderProse(text, { mode = "roleplay", caret = false } = {}) {
  const plain = mode === "plain";
  const blocks = splitBlocks(text || "", plain);
  if (blocks.length === 0) blocks.push({ type: "p", text: "" });
  return blocks.map((b, idx) => {
    const isLast = idx === blocks.length - 1;
    if (b.type === "code") {
      return <pre key={idx} className="code">{b.text}{isLast && caret ? <span className="caret" /> : null}</pre>;
    }
    return (
      <p key={idx}>
        {plain ? parsePlainWithBold(b.text) : parseRoleplay(b.text)}
        {isLast && caret ? <span className="caret" aria-hidden="true" /> : null}
      </p>
    );
  });
}

export const Prose = React.memo(function Prose({ text, mode, caret }) {
  return <div className="prose">{renderProse(text, { mode, caret })}</div>;
});
