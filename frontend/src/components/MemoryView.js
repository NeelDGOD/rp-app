import React from "react";

const HEADING = /^([A-Z][A-Z &]+):[ \t]*(.*)$/;

function parseSections(memory) {
  const sections = [];
  for (const line of memory.split("\n")) {
    const m = line.match(HEADING);
    if (m) sections.push({ title: m[1], lines: m[2] ? [m[2]] : [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else sections.push({ title: "", lines: [line] });
  }
  return sections.map(s => ({ ...s, text: s.lines.join("\n").trim() }));
}

// Read-only view of the memory document the bot is given on every reply.
export default function MemoryView({ memory }) {
  if (!memory?.trim()) {
    return <p className="sheet-note">Nothing remembered yet. The first memory update happens after a few turns.</p>;
  }
  return (
    <div className="memory-doc">
      {parseSections(memory).map((s, i) => (
        <section key={i} className="memory-doc__section">
          {s.title && <h3 className="field-label">{s.title}</h3>}
          <p className="memory-doc__text">{s.text || "Nothing recorded."}</p>
        </section>
      ))}
    </div>
  );
}
