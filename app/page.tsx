'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BrowserCompiler,
  type CompileResult,
  loadBrowserCompiler,
} from './compiler-runtime';

const examples = [
  {
    id: 'successor',
    label: 'Integer successor',
    description: 'Compile x + 1 to Untyped Plutus Core',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

succTyped :: Integer -> Integer
succTyped x = x Plinth.+ 1

succScript :: CompiledCode (Integer -> Integer)
succScript = $$(PlutusTx.compile [|| succTyped ||])`,
  },
  {
    id: 'equality',
    label: 'Integer equality',
    description: 'Compare two Plinth integers',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

eqTyped :: Integer -> Integer -> Bool
eqTyped x y = x Plinth.== y

eqScript :: CompiledCode (Integer -> Integer -> Bool)
eqScript = $$(PlutusTx.compile [|| eqTyped ||])`,
  },
  {
    id: 'arithmetic',
    label: 'Arithmetic expression',
    description: 'Combine multiplication and addition',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

calculate :: Integer -> Integer
calculate x = (x Plinth.* 2) Plinth.+ 7

calculateScript :: CompiledCode (Integer -> Integer)
calculateScript = $$(PlutusTx.compile [|| calculate ||])`,
  },
] as const;

type RuntimeState = 'loading' | 'ready' | 'compiling' | 'error';
type OutputTab = 'uplc' | 'flat' | 'diagnostics';

const initialOutput = `The real Plinth compiler is loading in an isolated worker.

The first visit downloads the GHC 9.12 + Plinth 1.66 runtime. Your source stays in this browser tab.`;

function formatFlat(hex: string) {
  return hex.match(/.{1,32}/g)?.join('\n') ?? hex;
}

export default function Home() {
  const [source, setSource] = useState<string>(examples[0].source);
  const [selectedExample, setSelectedExample] = useState<string>(examples[0].id);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('loading');
  const [runtimeDetail, setRuntimeDetail] = useState('Starting compiler worker');
  const [progress, setProgress] = useState(0);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>('uplc');
  const [activeProgram, setActiveProgram] = useState(0);
  const [copied, setCopied] = useState(false);
  const compilerRef = useRef<BrowserCompiler | null>(null);
  const lineCount = useMemo(() => source.split('\n').length, [source]);
  const program = result?.programs[activeProgram] ?? null;

  useEffect(() => {
    let cancelled = false;
    loadBrowserCompiler((nextProgress, detail) => {
      if (cancelled) return;
      setProgress(nextProgress);
      setRuntimeDetail(detail);
    })
      .then((compiler) => {
        if (cancelled) return;
        compilerRef.current = compiler;
        setRuntimeState('ready');
        setRuntimeDetail('GHC 9.12 + Plinth 1.66 ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRuntimeState('error');
        setRuntimeDetail(error instanceof Error ? error.message : 'Compiler failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const compile = useCallback(async () => {
    const compiler = compilerRef.current;
    if (!compiler || runtimeState !== 'ready') return;
    setRuntimeState('compiling');
    setRuntimeDetail('Running Plinth.Plugin');
    setDiagnostics([]);
    setResult(null);
    setActiveProgram(0);
    setCopied(false);

    const lines: string[] = [];
    try {
      const compiled = await compiler.compile(source, (kind, message) => {
        const line = kind === 'stderr' ? message : message;
        lines.push(line);
        setDiagnostics([...lines]);
      });
      setResult(compiled);
      setActiveTab('uplc');
      setRuntimeDetail(
        `${compiled.programs.length} program${compiled.programs.length === 1 ? '' : 's'} compiled in ${(compiled.elapsedMs / 1000).toFixed(1)}s`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Compilation failed';
      const customModuleHint = /Could not find module [‘']Utils/.test(lines.join('\n'))
        ? '\nHint: Utils is a project-local module, not part of Plinth. Inline that helper in this single-file editor.'
        : '';
      setDiagnostics([...lines, `${message}${customModuleHint}`]);
      setActiveTab('diagnostics');
      setRuntimeDetail('Compilation failed');
    } finally {
      setRuntimeState('ready');
    }
  }, [runtimeState, source]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void compile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compile]);

  const selectExample = (id: string) => {
    const next = examples.find((example) => example.id === id) ?? examples[0];
    setSelectedExample(next.id);
    setSource(next.source);
    setResult(null);
    setDiagnostics([]);
    setActiveTab('uplc');
  };

  const output = activeTab === 'diagnostics'
    ? diagnostics.length > 0
      ? diagnostics.join('\n')
      : 'No diagnostics yet.'
    : activeTab === 'flat'
      ? program
        ? formatFlat(program.flatHex)
        : initialOutput
      : program?.uplc ?? initialOutput;

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const downloadFlat = () => {
    if (!program) return;
    const pairs = program.flatHex.match(/.{2}/g) ?? [];
    const bytes = Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
    const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = program.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const isBusy = runtimeState === 'loading' || runtimeState === 'compiling';

  return (
    <main className="product-shell">
      <header className="app-header">
        <a className="brand" href="#workbench" aria-label="Plinth Lab home">
          <span className="brand-mark" aria-hidden="true">λ</span>
          <span className="brand-copy"><strong>Plinth Lab</strong><small>browser compiler</small></span>
        </a>
        <div className="runtime-badge" data-state={runtimeState}>
          <span className={isBusy ? 'pulse-dot' : runtimeState === 'error' ? 'error-dot' : 'ready-dot'} />
          <span>{runtimeState === 'loading' ? `${progress}% loading` : runtimeState === 'compiling' ? 'compiling' : runtimeState === 'error' ? 'runtime error' : 'compiler ready'}</span>
        </div>
        <a className="github-link" href="https://github.com/input-output-hk/ghc-plinth/tree/ghc-9.6-plinth" target="_blank" rel="noreferrer">
          ghc-plinth <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero-copy">
        <div>
          <p className="eyebrow">REAL PLINTH · FULLY CLIENT-SIDE</p>
          <h1>Compile on-chain Haskell<br />without leaving the browser.</h1>
        </div>
        <p>
          Write a self-contained Plinth module and inspect the exact Untyped Plutus Core and Flat bytes produced by <code>Plinth.Plugin</code>. Nothing is sent to a compile server.
        </p>
      </section>

      <section className="runtime-strip" aria-live="polite">
        <div className="runtime-message">
          <span className={isBusy ? 'spinner' : runtimeState === 'error' ? 'error-ring' : 'check-ring'} aria-hidden="true">
            {!isBusy && runtimeState !== 'error' ? '✓' : ''}
          </span>
          <span><strong>{runtimeDetail}</strong><small>{runtimeState === 'loading' ? 'One-time runtime download; cached by your browser' : runtimeState === 'compiling' ? 'Template Haskell and Plinth optimization are running locally' : 'GHC 9.12.4 · Plinth 1.66 · WASI'}</small></span>
        </div>
        <div className="progress-track" aria-hidden={runtimeState !== 'loading'}>
          <span style={{ width: `${runtimeState === 'loading' ? progress : 100}%` }} />
        </div>
      </section>

      <section className="workbench" id="workbench" aria-label="Plinth compiler workbench">
        <article className="work-panel editor-panel">
          <header className="panel-header">
            <div className="file-label"><span className="haskell-icon">Hs</span><span>Main.hs</span></div>
            <label className="example-select">
              <span>Example</span>
              <select value={selectedExample} onChange={(event) => selectExample(event.target.value)}>
                {examples.map((example) => <option value={example.id} key={example.id}>{example.label}</option>)}
              </select>
            </label>
          </header>
          <div className="editor-frame">
            <div className="line-numbers" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}
            </div>
            <textarea
              aria-label="Plinth Haskell source"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setSelectedExample('');
              }}
              spellCheck={false}
            />
          </div>
          <footer className="editor-footer"><span>Haskell</span><span>UTF-8</span><span>{lineCount} lines</span><span>single module</span></footer>
        </article>

        <article className="work-panel output-panel">
          <header className="panel-header output-header">
            <div className="output-tabs" role="tablist" aria-label="Compiler output">
              {(['uplc', 'flat', 'diagnostics'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>
                  {tab === 'uplc' ? 'UPLC' : tab === 'flat' ? 'Flat' : 'Diagnostics'}
                  {tab === 'diagnostics' && diagnostics.length > 0 ? <span>{diagnostics.length}</span> : null}
                </button>
              ))}
            </div>
            <div className="output-actions">
              <button type="button" onClick={() => void copyOutput()}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" disabled={!program} onClick={downloadFlat}>Download Flat</button>
            </div>
          </header>
          {result && result.programs.length > 1 ? (
            <div className="program-picker" aria-label="Compiled programs">
              {result.programs.map((item, index) => (
                <button type="button" key={item.filename} aria-pressed={activeProgram === index} onClick={() => setActiveProgram(index)}>
                  output {index + 1} <small>{item.byteLength} B</small>
                </button>
              ))}
            </div>
          ) : null}
          <pre className="compiler-output" data-empty={!program && activeTab !== 'diagnostics'}>{output}</pre>
          <footer className="compile-bar">
            <div className="compile-meta">
              {program ? <><strong>{program.byteLength} bytes</strong><span>{program.filename}</span></> : <><strong>Untyped Plutus Core</strong><span>Flat-encoded output</span></>}
            </div>
            <button className="compile-button" type="button" disabled={runtimeState !== 'ready'} onClick={() => void compile()}>
              <span aria-hidden="true">▶</span>
              {runtimeState === 'loading' ? 'Loading compiler' : runtimeState === 'compiling' ? 'Compiling…' : 'Compile Plinth'}
              <kbd>⌘↵</kbd>
            </button>
          </footer>
        </article>
      </section>

      <section className="info-grid" aria-label="Compiler details">
        <article><span className="info-number">01</span><div><strong>Actual Plinth plugin</strong><p>The same <code>Plinth.Plugin</code> pipeline produces the result—not a parser or mock.</p></div></article>
        <article><span className="info-number">02</span><div><strong>Private by construction</strong><p>GHC runs in a Web Worker. Source and generated Flat bytes remain on your device.</p></div></article>
        <article><span className="info-number">03</span><div><strong>Single-file workspace</strong><p>Package modules are available. Project-local imports such as <code>Utils</code> must be inlined for now.</p></div></article>
      </section>

      <footer className="site-footer">
        <span>Experimental compiler · expect a large first load</span>
        <span>Built from <a href="https://github.com/input-output-hk/ghc-plinth/tree/ghc-9.6-plinth" target="_blank" rel="noreferrer">ghc-9.6-plinth</a></span>
      </footer>
    </main>
  );
}
