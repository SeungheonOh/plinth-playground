'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clipboard,
  Download,
  ExternalLink,
  FileCode2,
  Hammer,
  LoaderCircle,
  Terminal,
} from 'lucide-react';
import {
  type BrowserCompiler,
  type CompileResult,
  loadBrowserCompiler,
} from './compiler-runtime';

const examples = [
  {
    id: 'successor',
    label: 'Integer successor',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

succTyped :: Integer -> Integer
succTyped x = x Plinth.+ 1

succScript :: CompiledCode (Integer -> Integer)
succScript = $$(PlutusTx.compile [|| succTyped ||])

main :: IO ()
main = pure ()`,
  },
  {
    id: 'utils',
    label: 'Imported Utils helper',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx
import PlutusTx.Prelude qualified as Plinth
import Utils qualified

addOne :: Integer -> Integer
addOne x = Utils.plusInteger x 1

compiledAddOne :: CompiledCode (Integer -> Integer)
compiledAddOne = $$(PlutusTx.compile [|| addOne ||])

main :: IO ()
main = pure ()`,
  },
  {
    id: 'equality',
    label: 'Integer equality',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

eqTyped :: Integer -> Integer -> Bool
eqTyped x y = x Plinth.== y

eqScript :: CompiledCode (Integer -> Integer -> Bool)
eqScript = $$(PlutusTx.compile [|| eqTyped ||])

main :: IO ()
main = pure ()`,
  },
  {
    id: 'validator',
    label: 'Simple validator',
    source: `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.Prelude qualified as Plinth
import PlutusTx.TH qualified as PlutusTx

validate :: Integer -> Integer -> Plinth.BuiltinUnit
validate expected actual =
  Plinth.check (expected Plinth.== actual)

validator :: CompiledCode (Integer -> Integer -> Plinth.BuiltinUnit)
validator = $$(PlutusTx.compile [|| validate ||])

main :: IO ()
main = pure ()`,
  },
] as const;

type RuntimeState = 'loading' | 'ready' | 'compiling' | 'error';
type OutputTab = 'uplc' | 'flat' | 'diagnostics';

const waitingMessage = `Compile Main.hs to inspect the Untyped Plutus Core emitted by Plinth.Plugin.

The compiler runs entirely in your browser. The first load downloads the GHC + Plinth runtime; later visits use the browser cache.`;

function formatFlat(hex: string) {
  return hex.match(/.{1,32}/g)?.join('\n') ?? hex;
}

export default function Home() {
  const [source, setSource] = useState<string>(examples[0].source);
  const [selectedExample, setSelectedExample] = useState<string>(examples[0].id);
  const [compiler, setCompiler] = useState<BrowserCompiler | null>(null);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('loading');
  const [runtimeDetail, setRuntimeDetail] = useState('Loading browser compiler');
  const [progress, setProgress] = useState(0);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>('uplc');
  const [activeProgram, setActiveProgram] = useState(0);
  const [copied, setCopied] = useState(false);
  const lineCount = useMemo(() => source.split('\n').length, [source]);
  const program = result?.programs[activeProgram] ?? null;
  const isBusy = runtimeState === 'loading' || runtimeState === 'compiling';

  useEffect(() => {
    let cancelled = false;
    loadBrowserCompiler((nextProgress, detail) => {
      if (cancelled) return;
      setProgress(nextProgress);
      setRuntimeDetail(detail);
    })
      .then((loadedCompiler) => {
        if (cancelled) return;
        setCompiler(loadedCompiler);
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
    if (!compiler || runtimeState !== 'ready') return;
    setRuntimeState('compiling');
    setRuntimeDetail('Running Plinth.Plugin');
    setDiagnostics([]);
    setResult(null);
    setActiveProgram(0);
    setCopied(false);

    const lines: string[] = [];
    try {
      const compiled = await compiler.compile(source, (_kind, message) => {
        lines.push(message);
        setDiagnostics([...lines]);
      });
      setResult(compiled);
      setActiveTab('uplc');
      setRuntimeDetail(`${compiled.programs.length} program${compiled.programs.length === 1 ? '' : 's'} compiled in ${(compiled.elapsedMs / 1000).toFixed(1)}s`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Compilation failed';
      const compilerOutput = lines.join('\n');
      const compiledCodeShowHint =
        compilerOutput.includes('No instance for') &&
        compilerOutput.includes('Show (CompiledCode')
          ? '\nHint: CompiledCode has no Show instance. This workspace already displays its UPLC, so use `main = pure ()`.'
          : '';
      setDiagnostics([...lines, `${message}${compiledCodeShowHint}`]);
      setActiveTab('diagnostics');
      setRuntimeDetail('Compilation failed');
    } finally {
      setRuntimeState('ready');
    }
  }, [compiler, runtimeState, source]);

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
    setActiveProgram(0);
  };

  const output = activeTab === 'diagnostics'
    ? diagnostics.length > 0 ? diagnostics.join('\n') : 'No compiler diagnostics.'
    : activeTab === 'flat'
      ? program ? formatFlat(program.flatHex) : waitingMessage
      : program?.uplc ?? waitingMessage;

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const downloadFlat = () => {
    if (!program) return;
    const pairs = program.flatHex.match(/.{2}/g) ?? [];
    const bytes = Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = program.filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  return (
    <main className="playground-shell">
      <header className="topbar">
        <div className="identity">
          <span className="identity-mark">λ</span>
          <strong>Plinth Playground</strong>
          <span className="identity-subtitle">Haskell → Untyped Plutus Core</span>
        </div>
        <div className="topbar-actions">
          <div className="compiler-state" data-state={runtimeState}>
            {isBusy ? <LoaderCircle size={13} /> : <span />}
            <span>{runtimeState === 'loading' ? `${progress}% loading` : runtimeState === 'compiling' ? 'compiling' : runtimeState === 'error' ? 'runtime error' : 'compiler ready'}</span>
          </div>
          <a className="icon-button" href="https://github.com/input-output-hk/ghc-plinth/tree/ghc-9.6-plinth" target="_blank" rel="noreferrer" aria-label="Open ghc-plinth on GitHub"><ExternalLink size={15} /></a>
          <button className="primary-button" type="button" disabled={runtimeState !== 'ready'} onClick={() => void compile()}>
            {runtimeState === 'compiling' ? <LoaderCircle size={14} /> : <Hammer size={14} />}
            Compile
            <kbd>⌘↵</kbd>
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="Plinth compiler workspace">
        <section className="source-pane">
          <header className="pane-toolbar">
            <div className="source-tabs">
              <button className="source-tab-active" type="button"><FileCode2 size={13} /> Main.hs</button>
            </div>
            <label className="example-picker">
              <span>Example</span>
              <span className="select-wrap">
                <select value={selectedExample} onChange={(event) => selectExample(event.target.value)}>
                  {examples.map((example) => <option key={example.id} value={example.id}>{example.label}</option>)}
                </select>
                <ChevronDown size={12} />
              </span>
            </label>
          </header>

          <div className="editor-area">
            <div className="line-gutter" aria-hidden="true">
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

          <footer className="pane-status">
            <span>Haskell</span>
            <span>{lineCount} lines</span>
            <span>UTF-8</span>
          </footer>
        </section>

        <div className="split-handle" aria-hidden="true"><span /></div>

        <section className="result-pane">
          <header className="pane-toolbar result-toolbar">
            <div className="result-tabs" role="tablist" aria-label="Compiler output">
              {(['uplc', 'flat', 'diagnostics'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>
                  {tab === 'uplc' ? 'UPLC' : tab === 'flat' ? 'Flat' : 'Diagnostics'}
                  {tab === 'diagnostics' && diagnostics.length > 0 ? <small>{diagnostics.length}</small> : null}
                </button>
              ))}
            </div>
            <div className="output-actions">
              <button type="button" onClick={() => void copyOutput()}><Clipboard size={13} />{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" disabled={!program} onClick={downloadFlat}><Download size={13} />Flat</button>
            </div>
          </header>

          {result && result.programs.length > 1 ? (
            <div className="program-tabs">
              {result.programs.map((item, index) => (
                <button key={item.filename} type="button" aria-pressed={activeProgram === index} onClick={() => setActiveProgram(index)}>
                  program {index + 1}<small>{item.byteLength} B</small>
                </button>
              ))}
            </div>
          ) : null}

          <div className="result-heading">
            <span><Terminal size={13} />{activeTab === 'uplc' ? 'Plinth compiler output' : activeTab === 'flat' ? 'Flat-encoded program' : 'Build messages'}</span>
            {program ? <small>{program.byteLength.toLocaleString()} bytes</small> : null}
          </div>
          <pre className="compiler-output" data-empty={!program && activeTab !== 'diagnostics'}>{output}</pre>
          <footer className="result-status">
            <span className="status-dot" data-state={runtimeState} />
            <span>{runtimeDetail}</span>
            {program ? <span className="result-ok"><Check size={11} /> compiled locally</span> : null}
          </footer>
        </section>
      </section>

      <footer className="app-statusbar">
        <span>Plinth 1.66</span>
        <span>GHC 9.12.4</span>
        <span>WASI worker</span>
        <span className="status-spacer" />
        <span>Source stays in this browser</span>
      </footer>
    </main>
  );
}
