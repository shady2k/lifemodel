// The documents the backlog rules read beside the tracker (model.md, "The
// outcome lines" and "The vision record"): the current milestone's outcomes
// with the vision ids each serves, from its charter, and the owner's journeys
// and principles, from the vision. Read at a revision (git show), or from the
// working tree when no revision is named, so a baseline is judged by the
// documents its own revision held.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONFIG = '.backlog/config.json';
const VISION = 'docs/vision.md';
const charterPath = (milestone) => `docs/charters/${milestone}.md`;

function reader(rev) {
  return (path) => {
    try {
      if (!rev) return readFileSync(path, 'utf8');
      return execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
    } catch {
      return null;
    }
  };
}

// The body of one `## <name>` section, up to the next `## ` heading.
function section(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

// One item per line, its stable id in front: `- J1: <the owner's words>`, the
// shape the set's own vision reader takes.
const ITEM = /^\s*[-*]\s*([A-Z][A-Za-z0-9_.-]*\d)\s*:\s*(\S.*)$/;
function items(lines) {
  return (lines || []).map((l) => ITEM.exec(l)).filter(Boolean).map((m) => ({ id: m[1], title: m[2].trim() }));
}

export function parseVision(text) {
  const journeys = section(text, 'Key journeys');
  const principles = section(text, 'Principles');
  if (!journeys && !principles) return null;
  return { journeys: items(journeys), principles: items(principles) };
}

// `- O1: **<title>** ...`, then indented lines of the same outcome, one of which
// is `Serves: J1, P2`. An outcome ends at the next outcome line or at the end of
// the Outcomes section.
const OUTCOME = /^- (O\d+):\s*(.*)$/;
const SERVES = /^\s*Serves:\s*(.*)$/;
export function parseOutcomes(text) {
  const lines = section(text, 'Outcomes');
  if (!lines) return [];
  const out = [];
  // The title is the outcome's bold phrase, which may wrap onto the next lines.
  let open = null;
  for (const l of lines) {
    const o = OUTCOME.exec(l);
    if (o) {
      open = { id: o[1], text: o[2], serves: [] };
      out.push(open);
      continue;
    }
    const s = SERVES.exec(l);
    if (s && open) open.serves = s[1].split(/[,\s]+/).filter(Boolean);
    else if (open && /^\s+\S/.test(l)) open.text += ` ${l.trim()}`;
  }
  return out.map(({ id, text, serves }) => {
    const bold = /\*\*(.+?)\*\*/.exec(text);
    return { id, title: (bold ? bold[1] : text.split(/(?<=\.)\s/)[0]).trim(), serves };
  });
}

/** The outcomes and vision at <rev>, or in the working tree with no rev. */
export function documentsAt(rev) {
  const read = reader(rev);
  const out = {};
  const vision = read(VISION);
  const parsedVision = vision ? parseVision(vision) : null;
  if (parsedVision) out.vision = parsedVision;
  let milestone = null;
  try {
    milestone = JSON.parse(read(CONFIG) || '{}').currentMilestone || null;
  } catch {
    /* a revision without a readable config names no charter */
  }
  const charter = milestone ? read(charterPath(milestone)) : null;
  const outcomes = charter ? parseOutcomes(charter) : [];
  // Only a charter that put ids on its outcomes declares any: an older one
  // without them is judged by none of the outcome rules (model.md, `outcomes`).
  if (outcomes.length) out.outcomes = outcomes;
  return out;
}
