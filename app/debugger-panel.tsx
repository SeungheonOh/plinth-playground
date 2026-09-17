'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Square, StepBack, StepForward } from 'lucide-react';
import type { BrowserCompiler, CekArgument, CompiledProgram, SourceModule } from './compiler-runtime';
import { type Breakpoint, type DebugSnapshot, type SourceSpan, focusedProjectSpans } from './cek-debugger';
import { encodeCekArgument } from './cek-arguments';
import { DebuggerInspector, SourceLink } from './debugger-inspector';

function spanLabel(span: SourceSpan) {
  return `${span.file}:${span.startLine}:${span.startColumn}–${span.endLine}:${span.endColumn}`;
}

export function DebuggerPanel({ compiler, program, arguments_, modules, breakpoints, onToggleBreakpoint, onLocation, onBusyChange }: {
  compiler: BrowserCompiler | null;
  program?: CompiledProgram | null;
  arguments_: CekArgument[];
  modules: SourceModule[];
  breakpoints: Breakpoint[];
  onToggleBreakpoint: (breakpoint: Breakpoint) => void;
  onLocation: (span: SourceSpan | null) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [breakFile, setBreakFile] = useState(modules[0]?.name ?? 'Main.hs');
  const [breakLine, setBreakLine] = useState('1');
  const running = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onLocation, onBusyChange });
  useEffect(() => { callbacks.current = { onLocation, onBusyChange }; }, [onLocation, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      running.current = false;
      callbacks.current.onLocation(null);
      callbacks.current.onBusyChange(false);
      void compiler?.debug({ op: 'stop' }).catch(() => {});
    };
  }, [compiler]);

  const update = (next: DebugSnapshot) => {
    if (!alive.current) return;
    setSnapshot(next);
    onLocation(focusedProjectSpans(next, modules)[0] ?? null);
  };
  const operate = async (mode: 'start' | 'back' | 'step' | 'source' | 'continue' | 'stop') => {
    if (!compiler || !program || busy) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      if (mode === 'stop') {
        await compiler.debug({ op: 'stop' });
        setSnapshot(null);
        onLocation(null);
        return;
      }
      if (mode === 'back') {
        const response = await compiler.debug({ op: 'back', count: 1 });
        if (!('epoch' in response)) throw new Error('Debugger did not return a machine state');
        update(response);
        return;
      }
      let current = snapshot;
      if (mode === 'start' || !current) {
        const response = await compiler.debug({ op: 'start', filename: program.filename, args: arguments_.map(encodeCekArgument) });
        if (!('epoch' in response)) throw new Error('Debugger did not return a machine state');
        current = response;
        update(current);
        if (mode === 'start') return;
      }
      const origin = JSON.stringify(focusedProjectSpans(current, modules)[0] ?? null);
      do {
        const response = await compiler.debug({ op: 'step', count: mode === 'step' ? 1 : 100, source: mode === 'source', breakpoints: mode === 'step' ? [] : breakpoints });
        if (!('epoch' in response)) throw new Error('Debugger did not return a machine state');
        current = response;
        update(current);
        if (mode === 'step' || current.done) break;
        const location = focusedProjectSpans(current, modules)[0];
        if (current.phase === 'computing' && location &&
          ((mode === 'source' && JSON.stringify(location) !== origin) ||
            breakpoints.some((bp) => bp.file === location.file && location.startLine <= bp.line && bp.line <= location.endLine))) break;
        // Yield between bounded batches: Pause does not wait for the whole run.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      } while (running.current && alive.current);
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : 'Debugger failed');
    } finally {
      running.current = false;
      if (alive.current) { setBusy(false); onBusyChange(false); }
    }
  };
  const locations = snapshot ? focusedProjectSpans(snapshot, modules) : [];
  const hasMachine = !!snapshot && !snapshot.done;
  const canGoBack = !!snapshot?.history && snapshot.step > snapshot.history.first;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['F8', 'F10', 'F11'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'F8' && busy) { running.current = false; return; }
      if (event.key === 'F10' && event.shiftKey) {
        if (!busy && canGoBack) void operate('back');
        return;
      }
      if (busy || !hasMachine) return;
      void operate(event.key === 'F10' ? 'step' : event.key === 'F11' ? 'source' : 'continue');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return <div className="debugger-panel">
    <div className="debug-controls" aria-label="CEK debugger controls">
      <button type="button" disabled={!program?.debugAvailable || !compiler || busy} onClick={() => void operate('start')}>
        {snapshot ? <RotateCcw size={13} /> : <Play size={13} />}{snapshot ? 'Restart' : 'Start debugger'}
      </button>
      <button type="button" disabled={!canGoBack || busy} title="Shift+F10 · Restore the previous CEK state, budget, and traces" onClick={() => void operate('back')}><StepBack size={13} />Back</button>
      <button type="button" disabled={!hasMachine || busy} title="F10 · Execute exactly one upstream CEK transition" onClick={() => void operate('step')}><StepForward size={13} />Step CEK</button>
      <button type="button" disabled={!hasMachine || busy} title="F11 · Advance to a different mapped expression" onClick={() => void operate('source')}>Next source</button>
      {busy ? <button type="button" onClick={() => { running.current = false; }}><Pause size={13} />Pause</button>
        : <button type="button" disabled={!hasMachine} onClick={() => void operate('continue')}><Play size={13} />Continue</button>}
      <button type="button" disabled={!snapshot || busy} onClick={() => void operate('stop')}><Square size={13} />Stop</button>
    </div>
    {error ? <p className="debug-error" role="alert">{error}</p> : null}
    {!snapshot ? <div className="debug-intro">
      <strong>{program ? program.debugAvailable ? 'Step through the compiled Plinth program' : 'No annotated Plinth output' : 'Compile a Plinth program first'}</strong>
      <p>{program?.debugAvailable ? 'Uses the arguments from Run. Step CEK advances one machine transition; Back restores the previous state. Next source stops at the next mapped expression.' : 'Source debugging requires a PlutusTx.compile output. Plutarch Main.main exports do not carry Plinth source spans.'}</p>
      <p>Optimizations may merge or remove source expressions. Unmapped steps remain visible as CEK states.</p>
    </div> : <>
      <div className="debug-state-bar" role="status" data-phase={snapshot.phase} data-step={snapshot.step}>
        <strong>Step {snapshot.step.toLocaleString()}</strong><span className="debug-phase">{snapshot.phase}</span><span>{snapshot.frames.length} {snapshot.frames.length === 1 ? 'frame' : 'frames'}</span>
      </div>
      {snapshot.history ? <div className="debug-history" title={`The most recent ${snapshot.history.limit.toLocaleString()} transitions are retained. History navigation does not rerun code or charge budget.`}>
        <span>{snapshot.step < snapshot.history.last ? 'Viewing history' : 'Latest state'}</span>
        <span>Retained steps {snapshot.history.first.toLocaleString()}–{snapshot.history.last.toLocaleString()}</span>
      </div> : null}
      {snapshot.action ? <p className="debug-action">{snapshot.action}</p> : null}
      <div className="debug-location">
        <strong>{snapshot.done ? snapshot.failure ? 'Failed at' : 'Finished' : snapshot.phase === 'returning' ? 'Returning to' : 'Next to execute'}</strong>
        {locations.length ? <div className="debug-source-links"><SourceLink span={locations[0]} onLocation={onLocation} />
          {locations.length > 1 ? <details><summary>+{locations.length - 1} {locations.length === 2 ? 'location' : 'locations'}</summary>{locations.slice(1).map((span, i) => <SourceLink key={i} span={span} onLocation={onLocation} />)}</details> : null}
        </div>
          : <span>{snapshot.done && !snapshot.failure ? 'Evaluation complete' : 'No project source span for this machine state'}</span>}
        {snapshot.spans.filter((span) => !modules.some((module) => module.name === span.file)).length ?
          <details><summary>Library / generated locations</summary>{snapshot.spans.filter((span) => !modules.some((module) => module.name === span.file)).map((span, i) => <code key={i}>{spanLabel(span)}</code>)}</details> : null}
      </div>
      <dl className="debug-budget">
        <div><dt>CPU</dt><dd>{BigInt(snapshot.budget.cpu).toLocaleString()} <small>ps</small></dd><span>{BigInt(snapshot.remaining.cpu).toLocaleString()} remaining</span></div>
        <div><dt>Memory</dt><dd>{BigInt(snapshot.budget.memory).toLocaleString()} <small>words</small></dd><span>{BigInt(snapshot.remaining.memory).toLocaleString()} remaining</span></div>
      </dl>
      {snapshot.failure ? <pre className="debug-error">{snapshot.failure}</pre> : null}
      {snapshot.result ? <section className="debug-section"><h3>Result</h3><pre>{snapshot.result}</pre></section> : null}
      {compiler ? <DebuggerInspector snapshot={snapshot} compiler={compiler} modules={modules} onLocation={onLocation} /> : null}
      <section className="debug-section"><h3>Trace log <small>{snapshot.logs.length}</small></h3>
        {snapshot.logs.length ? <ol className="debug-logs">{snapshot.logs.map((log, i) => <li key={i}>{log}</li>)}</ol> : <p>No traces emitted</p>}
      </section>
    </>}
    <section className="debug-section debug-breakpoints"><h3>Breakpoints</h3>
      <form onSubmit={(event) => {
        event.preventDefault();
        const sourceModule = modules.find((module) => module.name === breakFile);
        const line = Number(breakLine);
        if (sourceModule && Number.isInteger(line) && line > 0 && line <= sourceModule.source.split('\n').length) onToggleBreakpoint({ file: breakFile, line });
      }}>
        <select aria-label="Breakpoint module" value={breakFile} onChange={(event) => setBreakFile(event.target.value)}>{modules.map((module) => <option key={module.name}>{module.name}</option>)}</select>
        <input aria-label="Breakpoint line" type="number" min={1} value={breakLine} onChange={(event) => setBreakLine(event.target.value)} />
        <button type="submit">Toggle breakpoint</button>
      </form>
      {breakpoints.map((bp) => <button type="button" key={`${bp.file}:${bp.line}`} onClick={() => onToggleBreakpoint(bp)}>{bp.file}:{bp.line} ×</button>)}
    </section>
  </div>;
}
