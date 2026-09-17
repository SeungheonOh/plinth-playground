'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Code2, FileCode2, Layers3 } from 'lucide-react';
import type { BrowserCompiler } from './compiler-runtime';
import type { DebugObject, DebugReference, DebugSnapshot, SourceSpan } from './cek-debugger';

type InspectorContext = {
  epoch: number;
  load: (reference: DebugReference) => Promise<DebugObject>;
  expanded: Set<string>;
  toggle: (path: string, defaultOpen: boolean) => void;
};
const Inspector = createContext<InspectorContext | null>(null);

function useObject(reference: DebugReference | null, enabled = true) {
  const { epoch, load } = useContext(Inspector)!;
  const key = `${epoch}:${reference?.ref}`;
  const [loaded, setLoaded] = useState<{ key: string; value?: DebugObject; error?: string } | null>(null);
  useEffect(() => {
    if (!reference || !enabled) return;
    let alive = true;
    void load(reference).then((value) => {
      if (alive) setLoaded({ key, value });
    }).catch((error: Error) => { if (alive) setLoaded({ key, error: error.message }); });
    return () => { alive = false; };
  }, [load, key, reference, enabled]);
  return loaded?.key === key ? loaded : null;
}

// Presentation only. Machine data and source mapping always come from WASM;
// these labels are shortened for the table, with full values available below.
function presentReference(reference: DebugReference) {
  const indexed = reference.label.match(/^\[(\d+)\] ([\s\S]*)$/);
  const named = reference.label.split(' — ');
  let name = indexed ? `[${indexed[1]}]` : named[0];
  const description = indexed ? indexed[2] : named[1] ?? reference.label;
  const constant = description.match(/^Constant: \(con (\w+) ([\s\S]*)\)$/);
  let type = 'term';
  let preview = description;
  if (constant) { type = constant[1]; preview = constant[2]; }
  else if (description.startsWith('Constant: ')) { type = 'constant'; preview = description.slice(10); }
  else if (description.startsWith('Builtin: ')) { type = 'builtin'; preview = description.slice(9); }
  else if (description.startsWith('Lambda closure: ')) { type = 'closure'; preview = `λ ${description.slice(16)}`; }
  else if (description === 'Delay closure') { type = 'closure'; preview = 'delay'; }
  else if (description.startsWith('Constructor ')) { type = 'constructor'; preview = `tag ${description.slice(12)}`; }
  else if (/environment/i.test(description)) { type = 'environment'; preview = 'captured bindings'; }
  if (name === description && !indexed && type !== 'term') {
    name = type === 'environment' ? description.replace(/ \(.*/, '') : 'Value';
  }
  if (name === preview) preview = '';
  return { name, type, preview, indexed: !!indexed };
}

function FullText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const large = text.length > 1500;
  return <div className="inspector-code">
    {large && !all ? <pre>{text.slice(0, 800)}…</pre> : <pre>{text}</pre>}
    {large ? <button className="inspector-text-toggle" type="button" onClick={() => setAll(!all)}>
      {all ? 'Collapse term' : `Show full term · ${text.length.toLocaleString()} characters`}
    </button> : null}
  </div>;
}

function ValueNode({ reference, path }: { reference: DebugReference; path: string }) {
  const context = useContext(Inspector)!;
  const open = context.expanded.has(path);
  const loaded = useObject(reference, open);
  const display = presentReference(reference);
  return <div className="inspector-node" data-open={open} data-indexed={display.indexed}>
    <button type="button" className="inspector-node-toggle" aria-expanded={open} onClick={() => context.toggle(path, false)}>
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="inspector-node-name" title={display.name}>{display.name}</span>
      <span className="inspector-type" data-type={display.type}>{display.type}</span>
      <code className="inspector-preview" title={display.preview}>{display.preview || '…'}</code>
    </button>
    {open ? <div className="inspector-node-content">
      {loaded?.error ? <p className="inspector-error" role="alert">{loaded.error}</p>
        : !loaded?.value ? <p className="inspector-loading">Reading value…</p>
          : <>
            {loaded.value.text ? <FullText text={loaded.value.text} /> : null}
            {loaded.value.children.length ? <div className="inspector-children">{loaded.value.children.map((child, index) =>
              <ValueNode key={`${index}:${child.label}`} reference={child} path={`${path}/${index}`} />)}</div>
              : !loaded.value.text ? <p className="inspector-empty">No bindings</p> : null}
          </>}
    </div> : null}
  </div>;
}

export function SourceLink({ span, onLocation }: { span: SourceSpan; onLocation: (span: SourceSpan) => void }) {
  const label = `${span.file}:${span.startLine}:${span.startColumn}–${span.endLine}:${span.endColumn}`;
  return <button type="button" className="inspector-source-link" onClick={() => onLocation(span)} title={label}>
    <FileCode2 size={12} /><span>{span.file}</span><code>{span.startLine}:{span.startColumn}</code>
  </button>;
}

function EnvironmentCard({ reference }: { reference: DebugReference | null }) {
  const loaded = useObject(reference);
  return <section className="inspector-card inspector-environment" aria-label="CEK environment">
    <header className="inspector-card-header"><span className="inspector-letter">E</span><h3>Environment</h3>
      {loaded?.value ? <span className="inspector-count">{loaded.value.children.length}</span> : null}
    </header>
    {!reference ? <div className="inspector-empty-state"><Layers3 size={18} /><strong>No active environment</strong><p>Captured bindings are available inside closures and saved frames.</p></div>
      : loaded?.error ? <p className="inspector-error">{loaded.error}</p>
        : !loaded?.value ? <p className="inspector-loading">Reading bindings…</p>
          : !loaded.value.children.length ? <div className="inspector-empty-state"><Layers3 size={18} /><strong>No bindings yet</strong><p>Bindings appear when arguments enter a function.</p></div>
            : <>
              <div className="inspector-table-heading"><span>Index</span><span>Type</span><span>Value</span></div>
              <div className="inspector-bindings">{loaded.value.children.map((child, index) => <ValueNode key={index} reference={child} path={`environment/${index}`} />)}</div>
              <footer className="inspector-card-note">Index 1 is the most recent binding.</footer>
            </>}
  </section>;
}

function FrameCard({ frame, index, modules, onLocation }: {
  frame: DebugSnapshot['frames'][number]; index: number; modules: string[]; onLocation: (span: SourceSpan) => void;
}) {
  const context = useContext(Inspector)!;
  const path = `frame/${index}`;
  const open = context.expanded.has(path) || (index === 0 && !context.expanded.has(`${path}/closed`));
  const source = frame.spans.filter((span) => modules.includes(span.file))
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine) || (a.endColumn - a.startColumn) - (b.endColumn - b.startColumn));
  return <li className="inspector-frame" data-top={index === 0}>
    <button className="inspector-frame-toggle" type="button" aria-expanded={open} onClick={() => context.toggle(path, index === 0)}>
      <span className="inspector-frame-number">{String(index).padStart(2, '0')}</span>
      <strong>{frame.kind}</strong>
      {index === 0 ? <span className="inspector-top-tag">top</span> : <span className="inspector-frame-count">{frame.fields.length}</span>}
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
    {open ? <div className="inspector-frame-body">
      {source[0] ? <div className="inspector-frame-source"><SourceLink span={source[0]} onLocation={onLocation} />
        {source.length > 1 ? <details><summary>+{source.length - 1}</summary>{source.slice(1).map((span, i) => <SourceLink key={i} span={span} onLocation={onLocation} />)}</details> : null}
      </div> : null}
      {frame.fields.map((reference, i) => <ValueNode key={`${i}:${reference.label}`} reference={reference} path={`${path}/${i}`} />)}
      {!frame.fields.length ? <p className="inspector-empty">No stored values</p> : null}
    </div> : null}
  </li>;
}

function ControlCard({ reference, phase }: { reference: DebugReference | null; phase: string }) {
  const loaded = useObject(reference);
  if (!reference) return null;
  return <section className="inspector-card inspector-control" aria-label="CEK control">
    <header className="inspector-card-header"><span className="inspector-letter">C</span>
      <h3>{phase === 'returning' ? 'Returning value' : 'Control'}</h3>
      <span className="inspector-control-kind">{reference.label}</span>
    </header>
    <div className="inspector-control-body">
      {loaded?.error ? <p className="inspector-error">{loaded.error}</p> : !loaded?.value ? <p className="inspector-loading">Reading control…</p> : <>
        {loaded.value.text ? <FullText text={loaded.value.text} /> : null}
        {loaded.value.children.length ? <details className="inspector-control-structure" open={!loaded.value.text}>
          <summary><Code2 size={12} />{loaded.value.text ? 'Term structure' : 'Closure contents'}<span>{loaded.value.children.length}</span></summary>
          {loaded.value.children.map((child, i) => <ValueNode key={i} reference={child} path={`control/${i}`} />)}
        </details> : null}
      </>}
    </div>
  </section>;
}

export function DebuggerInspector({ snapshot, compiler, modules, onLocation }: {
  snapshot: DebugSnapshot; compiler: BrowserCompiler; modules: string[]; onLocation: (span: SourceSpan) => void;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const cache = useRef({ epoch: -1, entries: new Map<number, Promise<DebugObject>>() });
  const load = useCallback((reference: DebugReference) => {
    if (cache.current.epoch !== snapshot.epoch) cache.current = { epoch: snapshot.epoch, entries: new Map() };
    const entries = cache.current.entries;
    if (!entries.has(reference.ref)) entries.set(reference.ref, compiler.debug({ op: 'inspect', epoch: snapshot.epoch, ref: reference.ref })
      .then((value) => { if (!('kind' in value)) throw new Error('Invalid debugger value'); return value; }));
    return entries.get(reference.ref)!;
  }, [compiler, snapshot.epoch]);
  const toggle = useCallback((path: string, defaultOpen: boolean) => setExpanded((current) => {
    const next = new Set(current);
    const open = next.has(path) || (defaultOpen && !next.has(`${path}/closed`));
    if (open) { next.delete(path); next.add(`${path}/closed`); }
    else { next.add(path); next.delete(`${path}/closed`); }
    return next;
  }), []);
  const context = useMemo(() => ({ epoch: snapshot.epoch, load, expanded, toggle }), [snapshot.epoch, load, expanded, toggle]);
  return <Inspector.Provider value={context}>
    <div className="debug-inspector">
      <ControlCard reference={snapshot.control} phase={snapshot.phase} />
      <div className="inspector-state-grid">
        <EnvironmentCard reference={snapshot.environment} />
        <section className="inspector-card inspector-stack" aria-label="CEK continuation stack">
          <header className="inspector-card-header"><span className="inspector-letter">K</span><h3>Continuation</h3><span className="inspector-count">{snapshot.frames.length}</span></header>
          {snapshot.frames.length ? <ol className="inspector-frames">{snapshot.frames.map((frame, index) => <FrameCard key={`${index}:${frame.kind}`} frame={frame} index={index} modules={modules} onLocation={onLocation} />)}</ol>
            : <div className="inspector-empty-state"><Layers3 size={18} /><strong>Empty stack</strong><p>No pending computation.</p></div>}
        </section>
      </div>
    </div>
  </Inspector.Provider>;
}
