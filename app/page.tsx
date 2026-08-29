'use client';

import CodeMirror from '@uiw/react-codemirror';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { tags } from '@lezer/highlight';
import {
  Check,
  ChevronDown,
  Clipboard,
  Download,
  ExternalLink,
  FileCode2,
  FilePlus2,
  Hammer,
  Link,
  LoaderCircle,
  Play,
  Plus,
  Share2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type BrowserCompiler,
  type CekArgument,
  type CekArgumentKind,
  type CekEvaluationResult,
  type CompileResult,
  type SourceModule,
  loadBrowserCompiler,
} from './compiler-runtime';
import { decodeSharedProject, encodeSharedProject } from './project-share';

const multiModuleMain = `{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
module Main where

import LocalMath qualified
import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx

addTwo :: Integer -> Integer
addTwo = LocalMath.addTwo

addTwoScript :: CompiledCode (Integer -> Integer)
addTwoScript = $$(PlutusTx.compile [|| addTwo ||])

main :: IO ()
main = pure ()`;

const multiModuleHelper = `{-# LANGUAGE NoImplicitPrelude #-}
module LocalMath (addTwo) where

import PlutusTx.Prelude

{-# INLINABLE addTwo #-}
addTwo :: Integer -> Integer
addTwo value = value + 2`;

const examples = [
  {
    id: 'successor',
    label: 'Integer successor',
    args: [{ kind: 'integer', value: '41' }],
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
    args: [{ kind: 'integer', value: '8' }],
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
    id: 'modules',
    label: 'Multiple modules',
    args: [{ kind: 'integer', value: '40' }],
    source: multiModuleMain,
    modules: [
      { name: 'Main.hs', source: multiModuleMain },
      { name: 'LocalMath.hs', source: multiModuleHelper },
    ],
  },
  {
    id: 'equality',
    label: 'Integer equality',
    args: [
      { kind: 'integer', value: '42' },
      { kind: 'integer', value: '42' },
    ],
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
    args: [
      { kind: 'integer', value: '7' },
      { kind: 'integer', value: '7' },
    ],
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
] satisfies Array<{
  id: string;
  label: string;
  args: CekArgument[];
  source: string;
  modules?: SourceModule[];
}>;

const argumentKinds: Array<{ kind: CekArgumentKind; label: string }> = [
  { kind: 'integer', label: 'Integer' },
  { kind: 'bytes', label: 'ByteString' },
  { kind: 'string', label: 'String' },
  { kind: 'bool', label: 'Bool' },
  { kind: 'unit', label: 'Unit' },
  { kind: 'data', label: 'Data' },
];

const argumentDefaults: Record<CekArgumentKind, string> = {
  integer: '0',
  bytes: '',
  string: '',
  bool: 'true',
  unit: '',
  data: 'I 0',
};

const argumentPlaceholders: Record<CekArgumentKind, string> = {
  integer: '42',
  bytes: 'deadbeef',
  string: 'hello',
  bool: 'true',
  unit: '()',
  data: 'Constr 0 [I 42]',
};

const haskellLanguage = StreamLanguage.define(haskell);
const haskellHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#7157a5', fontWeight: '600' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#2f6690' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: '#146b58' },
  { tag: [tags.string, tags.character], color: '#9a4b35' },
  { tag: [tags.number, tags.bool], color: '#a15c12' },
  { tag: [tags.lineComment, tags.blockComment], color: '#89928d', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: '#59635e' },
  { tag: tags.meta, color: '#7d526d' },
]);

type RuntimeState = 'loading' | 'ready' | 'compiling' | 'evaluating' | 'error';
type OutputTab = 'uplc' | 'run' | 'flat' | 'diagnostics';
type ShareState = 'idle' | 'copying' | 'copied' | 'error';

const waitingMessage = `Compile the project to inspect the Untyped Plutus Core emitted by Plinth.Plugin.

GHC, Plinth, and the CEK evaluator all run locally in this browser. The first visit downloads the compiler runtime; later visits use the browser cache.`;

function formatFlat(hex: string) {
  return hex.match(/.{1,32}/g)?.join('\n') ?? hex;
}

function cloneArguments(args: CekArgument[]) {
  return args.map((argument) => ({ ...argument }));
}

function cloneModules(modules: SourceModule[]) {
  return modules.map((sourceModule) => ({ ...sourceModule }));
}

function modulesForExample(example: (typeof examples)[number]) {
  return cloneModules(example.modules ?? [{ name: 'Main.hs', source: example.source }]);
}

function moduleNameToPath(moduleName: string) {
  return `${moduleName.replace(/\./g, '/')}.hs`;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function formatNumber(value: string) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number.toLocaleString() : value;
}

export default function Home() {
  const [modules, setModules] = useState<SourceModule[]>(() => modulesForExample(examples[0]));
  const [activeModule, setActiveModule] = useState('Main.hs');
  const [moduleDraft, setModuleDraft] = useState('');
  const [moduleDraftError, setModuleDraftError] = useState('');
  const [isAddingModule, setIsAddingModule] = useState(false);
  const [selectedExample, setSelectedExample] = useState(examples[0].id);
  const [compiler, setCompiler] = useState<BrowserCompiler | null>(null);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('loading');
  const [runtimeDetail, setRuntimeDetail] = useState('Loading browser compiler');
  const [progress, setProgress] = useState(0);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>('uplc');
  const [activeProgram, setActiveProgram] = useState(0);
  const [arguments_, setArguments] = useState<CekArgument[]>(cloneArguments(examples[0].args));
  const [evaluation, setEvaluation] = useState<CekEvaluationResult | null>(null);
  const [evaluationError, setEvaluationError] = useState('');
  const [copied, setCopied] = useState(false);
  const [shareState, setShareState] = useState<ShareState>('idle');
  const [shareNotice, setShareNotice] = useState('');
  const [splitPosition, setSplitPosition] = useState(() => {
    if (typeof window === 'undefined') return 54;
    const saved = Number(window.localStorage.getItem('plinth-workspace-split'));
    return saved >= 30 && saved <= 70 ? saved : 54;
  });
  const [isResizing, setIsResizing] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);

  const currentModule = modules.find((sourceModule) => sourceModule.name === activeModule) ?? modules[0];
  const source = currentModule?.source ?? '';
  const lineCount = useMemo(() => source.split('\n').length, [source]);
  const program = result?.programs[activeProgram] ?? null;
  const isBusy = runtimeState === 'loading' || runtimeState === 'compiling' || runtimeState === 'evaluating';

  useEffect(() => {
    let request = 0;
    const restoreSharedProject = () => {
      const currentRequest = ++request;
      const payload = new URLSearchParams(window.location.hash.slice(1)).get('p');
      if (!payload) return;
      void decodeSharedProject(payload)
        .then((project) => {
          if (request !== currentRequest) return;
          setModules(cloneModules(project.modules));
          setActiveModule(project.active);
          setArguments(cloneArguments(project.arguments));
          setSelectedExample('');
          setResult(null);
          setEvaluation(null);
          setEvaluationError('');
          setDiagnostics([]);
          setActiveTab('uplc');
          setActiveProgram(0);
          setShareState('idle');
          setShareNotice(`Shared project loaded · ${project.modules.length} module${project.modules.length === 1 ? '' : 's'}`);
        })
        .catch((error: unknown) => {
          if (request !== currentRequest) return;
          setShareState('error');
          setShareNotice(error instanceof Error ? error.message : 'Could not open this project link');
        });
    };
    restoreSharedProject();
    window.addEventListener('hashchange', restoreSharedProject);
    return () => {
      request += 1;
      window.removeEventListener('hashchange', restoreSharedProject);
    };
  }, []);

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
    setEvaluation(null);
    setEvaluationError('');
    setActiveProgram(0);
    setCopied(false);

    const lines: string[] = [];
    try {
      const compiled = await compiler.compile(modules, (_kind, message) => {
        lines.push(message);
        setDiagnostics([...lines]);
      });
      setResult(compiled);
      setActiveTab('run');
      setRuntimeDetail(`${compiled.programs.length} program${compiled.programs.length === 1 ? '' : 's'} compiled in ${(compiled.elapsedMs / 1000).toFixed(1)}s`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Compilation failed';
      const compilerOutput = lines.join('\n');
      const compiledCodeShowHint =
        compilerOutput.includes('No instance for') && compilerOutput.includes('Show (CompiledCode')
          ? '\nHint: CompiledCode has no Show instance. The playground already captures its UPLC, so use `main = pure ()`.'
          : '';
      setDiagnostics([...lines, `${message}${compiledCodeShowHint}`]);
      setActiveTab('diagnostics');
      setRuntimeDetail('Compilation failed');
    } finally {
      setRuntimeState('ready');
    }
  }, [compiler, modules, runtimeState]);

  const runEvaluation = useCallback(async () => {
    if (!compiler || !program || runtimeState !== 'ready') return;
    setRuntimeState('evaluating');
    setRuntimeDetail('Loading and running the CEK machine');
    setEvaluation(null);
    setEvaluationError('');
    setActiveTab('run');
    setCopied(false);
    try {
      const evaluated = await compiler.evaluate(program.filename, arguments_);
      setEvaluation(evaluated);
      setRuntimeDetail(
        `${evaluated.succeeded ? 'Evaluation completed' : 'Evaluation failed'} in ${evaluated.elapsedMs < 1000 ? `${Math.round(evaluated.elapsedMs)}ms` : `${(evaluated.elapsedMs / 1000).toFixed(1)}s`}`,
      );
    } catch (error: unknown) {
      setEvaluationError(error instanceof Error ? error.message : 'CEK evaluation failed');
      setRuntimeDetail('CEK runner failed');
    } finally {
      setRuntimeState('ready');
    }
  }, [arguments_, compiler, program, runtimeState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        void runEvaluation();
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void compile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compile, runEvaluation]);

  const selectExample = (id: string) => {
    const next = examples.find((example) => example.id === id) ?? examples[0];
    setSelectedExample(next.id);
    setModules(modulesForExample(next));
    setActiveModule('Main.hs');
    setIsAddingModule(false);
    setModuleDraft('');
    setModuleDraftError('');
    setArguments(cloneArguments(next.args));
    setResult(null);
    setEvaluation(null);
    setEvaluationError('');
    setDiagnostics([]);
    setActiveTab('uplc');
    setActiveProgram(0);
  };

  const changeSource = (value: string) => {
    setModules((current) => current.map((sourceModule) => (
      sourceModule.name === activeModule ? { ...sourceModule, source: value } : sourceModule
    )));
    setSelectedExample('');
    if (result) {
      setResult(null);
      setEvaluation(null);
      setEvaluationError('');
      setDiagnostics([]);
      setActiveTab('uplc');
    }
  };

  const openModuleCreator = () => {
    setModuleDraft('');
    setModuleDraftError('');
    setIsAddingModule(true);
  };

  const addModule = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const moduleName = moduleDraft.trim().replace(/\.hs$/, '').replace(/\//g, '.');
    if (!/^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/.test(moduleName)) {
      setModuleDraftError('Use a Haskell module name such as Utils or Validators.Math');
      return;
    }
    if (moduleName === 'Main') {
      setModuleDraftError('Main.hs already exists');
      return;
    }
    const path = moduleNameToPath(moduleName);
    if (modules.some((sourceModule) => sourceModule.name === path)) {
      setModuleDraftError(`${path} already exists`);
      return;
    }
    setModules((current) => [
      ...current,
      { name: path, source: `module ${moduleName} where\n\n` },
    ]);
    setActiveModule(path);
    setSelectedExample('');
    setIsAddingModule(false);
    setModuleDraft('');
    setModuleDraftError('');
    setResult(null);
    setEvaluation(null);
    setEvaluationError('');
    setDiagnostics([]);
    setActiveTab('uplc');
    setActiveProgram(0);
  };

  const removeModule = (name: string) => {
    if (name === 'Main.hs') return;
    const sourceModule = modules.find((item) => item.name === name);
    if (!sourceModule) return;
    if (sourceModule.source.trim() && !window.confirm(`Delete ${name}? Its source code will be removed from this project.`)) {
      return;
    }
    setModules((current) => current.filter((item) => item.name !== name));
    if (activeModule === name) setActiveModule('Main.hs');
    setSelectedExample('');
    setResult(null);
    setEvaluation(null);
    setEvaluationError('');
    setDiagnostics([]);
    setActiveTab('uplc');
    setActiveProgram(0);
  };

  const shareProject = async () => {
    setShareState('copying');
    setShareNotice('Creating project link');
    try {
      const payload = await encodeSharedProject(modules, activeModule, arguments_);
      const url = new URL(window.location.href);
      url.hash = new URLSearchParams({ p: payload }).toString();
      window.history.replaceState(null, '', url);
      const copiedToClipboard = await copyText(url.toString());
      setShareState('copied');
      setShareNotice(
        `${copiedToClipboard ? 'Link copied' : 'Link ready in the address bar'} · ${modules.length} module${modules.length === 1 ? '' : 's'} included`,
      );
      window.setTimeout(() => setShareState('idle'), 1_600);
    } catch (error: unknown) {
      setShareState('error');
      setShareNotice(error instanceof Error ? error.message : 'Could not create a project link');
    }
  };

  const updateArgument = (index: number, patch: Partial<CekArgument>) => {
    setArguments((current) => current.map((argument, itemIndex) => (
      itemIndex === index ? { ...argument, ...patch } : argument
    )));
    setEvaluation(null);
    setEvaluationError('');
  };

  const changeArgumentKind = (index: number, kind: CekArgumentKind) => {
    updateArgument(index, { kind, value: argumentDefaults[kind] });
  };

  const addArgument = () => {
    setArguments((current) => [...current, { kind: 'integer', value: '0' }]);
    setEvaluation(null);
    setEvaluationError('');
  };

  const removeArgument = (index: number) => {
    setArguments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEvaluation(null);
    setEvaluationError('');
  };

  const textOutput = activeTab === 'diagnostics'
    ? diagnostics.length > 0 ? diagnostics.join('\n') : 'No compiler diagnostics.'
    : activeTab === 'flat'
      ? program ? formatFlat(program.flatHex) : waitingMessage
      : program?.uplc ?? waitingMessage;

  const copyableOutput = activeTab === 'run'
    ? evaluation
      ? [
          evaluation.succeeded ? evaluation.value : evaluation.error,
          `CPU: ${evaluation.budget.cpu}`,
          `Memory: ${evaluation.budget.memory}`,
          ...evaluation.logs.map((log) => `Trace: ${log}`),
        ].filter(Boolean).join('\n')
      : evaluationError || 'No CEK result yet.'
    : textOutput;

  const copyOutput = async () => {
    if (await copyText(copyableOutput)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
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

  const updateSplitFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isResizing || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    const isVertical = bounds.width <= 820;
    const raw = isVertical
      ? ((event.clientY - bounds.top) / bounds.height) * 100
      : ((event.clientX - bounds.left) / bounds.width) * 100;
    const next = Math.min(70, Math.max(30, Math.round(raw * 10) / 10));
    setSplitPosition(next);
    window.localStorage.setItem('plinth-workspace-split', String(next));
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsResizing(false);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? -2
      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 2
        : 0;
    if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 30 : event.key === 'End' ? 70 : Math.min(70, Math.max(30, splitPosition + direction));
    setSplitPosition(next);
    window.localStorage.setItem('plinth-workspace-split', String(next));
  };

  const workspaceStyle = {
    '--split-position': `${splitPosition}%`,
  } as CSSProperties;

  const stateLabel = runtimeState === 'loading'
    ? `${progress}% loading`
    : runtimeState === 'compiling'
      ? 'compiling'
      : runtimeState === 'evaluating'
        ? 'evaluating'
        : runtimeState === 'error'
          ? 'runtime error'
          : 'runtime ready';

  return (
    <main className={`playground-shell${isResizing ? ' is-resizing' : ''}`}>
      <header className="topbar">
        <div className="identity">
          <span className="identity-mark">λ</span>
          <span className="identity-copy">
            <strong>Plinth Playground</strong>
            <small>Compile and run Plutus in your browser</small>
          </span>
        </div>
        <div className="topbar-actions">
          <div className="compiler-state" data-state={runtimeState}>
            {isBusy ? <LoaderCircle size={13} /> : <span />}
            <span>{stateLabel}</span>
          </div>
          <button
            aria-label="Copy a share link containing this project"
            className="secondary-button share-button"
            disabled={shareState === 'copying'}
            onClick={() => void shareProject()}
            type="button"
          >
            {shareState === 'copying' ? <LoaderCircle className="lucide-loader-circle" size={14} /> : <Share2 size={14} />}
            {shareState === 'copied' ? 'Link copied' : 'Share'}
          </button>
          <a className="icon-button" href="https://github.com/input-output-hk/ghc-plinth/tree/ghc-9.6-plinth" target="_blank" rel="noreferrer" aria-label="Open ghc-plinth on GitHub">
            <ExternalLink size={15} />
          </a>
          <button className="secondary-button" type="button" disabled={!program || runtimeState !== 'ready'} onClick={() => void runEvaluation()}>
            {runtimeState === 'evaluating' ? <LoaderCircle size={14} /> : <Play size={14} />}
            Run CEK
          </button>
          <button className="primary-button" type="button" disabled={runtimeState !== 'ready'} onClick={() => void compile()}>
            {runtimeState === 'compiling' ? <LoaderCircle size={14} /> : <Hammer size={14} />}
            Compile
            <kbd>⌘↵</kbd>
          </button>
        </div>
      </header>

      {shareNotice ? (
        <div className="share-notice" data-state={shareState} role="status">
          <Link size={13} />
          <span>{shareNotice}</span>
          <button aria-label="Dismiss share message" onClick={() => setShareNotice('')} type="button">
            <X size={12} />
          </button>
        </div>
      ) : null}

      <section ref={workspaceRef} className="workspace" style={workspaceStyle} aria-label="Plinth compiler workspace">
        <section className="source-pane">
          <header className="pane-toolbar source-toolbar">
            <div className="source-tabs" role="tablist" aria-label="Project modules">
              {modules.map((sourceModule) => (
                <div className="module-tab" data-active={activeModule === sourceModule.name} key={sourceModule.name}>
                  <button
                    aria-selected={activeModule === sourceModule.name}
                    className="module-tab-select"
                    onClick={() => setActiveModule(sourceModule.name)}
                    role="tab"
                    title={sourceModule.name}
                    type="button"
                  >
                    <FileCode2 size={13} />
                    <span>{sourceModule.name}</span>
                  </button>
                  {sourceModule.name !== 'Main.hs' ? (
                    <button
                      aria-label={`Delete ${sourceModule.name}`}
                      className="module-tab-close"
                      onClick={() => removeModule(sourceModule.name)}
                      title={`Delete ${sourceModule.name}`}
                      type="button"
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                aria-label="Add a Haskell module"
                className="add-module-tab"
                onClick={openModuleCreator}
                title="Add module"
                type="button"
              >
                <FilePlus2 size={13} />
              </button>
            </div>
            <label className="example-picker">
              <span>Example</span>
              <span className="select-wrap">
                <select value={selectedExample} onChange={(event) => selectExample(event.target.value)}>
                  {selectedExample === '' ? <option value="">Custom source</option> : null}
                  {examples.map((example) => <option key={example.id} value={example.id}>{example.label}</option>)}
                </select>
                <ChevronDown size={12} />
              </span>
            </label>
          </header>

          {isAddingModule ? (
            <form className="module-creator" onSubmit={addModule}>
              <span className="module-creator-icon"><FilePlus2 size={14} /></span>
              <label>
                <span>New module</span>
                <input
                  autoFocus
                  onChange={(event) => {
                    setModuleDraft(event.target.value);
                    setModuleDraftError('');
                  }}
                  placeholder="Utils or Validators.Math"
                  spellCheck={false}
                  value={moduleDraft}
                />
              </label>
              <span className="module-creator-path">
                {moduleDraft.trim() ? moduleNameToPath(moduleDraft.trim().replace(/\.hs$/, '').replace(/\//g, '.')) : 'Module.hs'}
              </span>
              <button className="module-create-button" type="submit">Create</button>
              <button
                aria-label="Cancel adding module"
                className="module-cancel-button"
                onClick={() => {
                  setIsAddingModule(false);
                  setModuleDraftError('');
                }}
                type="button"
              >
                <X size={13} />
              </button>
              {moduleDraftError ? <small role="alert">{moduleDraftError}</small> : null}
            </form>
          ) : null}

          <div className="editor-area">
            <CodeMirror
              aria-label={`${activeModule} Haskell source`}
              basicSetup
              className="source-editor"
              extensions={[haskellLanguage, syntaxHighlighting(haskellHighlighting)]}
              height="100%"
              key={activeModule}
              onChange={changeSource}
              placeholder="Write a Plinth module…"
              theme="light"
              value={source}
            />
          </div>

          <footer className="pane-status">
            <span>Haskell</span>
            <span>{lineCount} lines</span>
            <span>{modules.length} module{modules.length === 1 ? '' : 's'}</span>
            <span>UTF-8</span>
          </footer>
        </section>

        <div
          aria-label="Resize source and output panes"
          aria-valuemax={70}
          aria-valuemin={30}
          aria-valuenow={Math.round(splitPosition)}
          className="split-handle"
          onDoubleClick={() => {
            setSplitPosition(54);
            window.localStorage.setItem('plinth-workspace-split', '54');
          }}
          onKeyDown={resizeWithKeyboard}
          onPointerCancel={finishResize}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsResizing(true);
          }}
          onPointerMove={updateSplitFromPointer}
          onPointerUp={finishResize}
          role="separator"
          tabIndex={0}
        >
          <span />
        </div>

        <section className="result-pane">
          <header className="pane-toolbar result-toolbar">
            <div className="result-tabs" role="tablist" aria-label="Compiler and evaluator output">
              {(['uplc', 'run', 'flat', 'diagnostics'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>
                  {tab === 'uplc' ? 'UPLC' : tab === 'run' ? 'Run' : tab === 'flat' ? 'Flat' : 'Diagnostics'}
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
                <button
                  key={item.filename}
                  type="button"
                  aria-pressed={activeProgram === index}
                  onClick={() => {
                    setActiveProgram(index);
                    setEvaluation(null);
                    setEvaluationError('');
                  }}
                >
                  program {index + 1}<small>{item.byteLength} B</small>
                </button>
              ))}
            </div>
          ) : null}

          {activeTab === 'run' ? (
            <div className="run-workspace">
              <section className="argument-panel" aria-label="CEK arguments">
                <header className="section-heading">
                  <span>
                    <strong>Arguments</strong>
                    <small>Applied left to right before evaluation</small>
                  </span>
                  <button type="button" onClick={addArgument}><Plus size={13} /> Add argument</button>
                </header>

                <div className="argument-list">
                  {arguments_.length === 0 ? (
                    <div className="no-arguments">No arguments — run the compiled program as-is.</div>
                  ) : arguments_.map((argument, index) => (
                    <div className="argument-row" key={`${index}-${argument.kind}`}>
                      <span className="argument-index">{index + 1}</span>
                      <span className="argument-type select-wrap">
                        <select value={argument.kind} aria-label={`Argument ${index + 1} type`} onChange={(event) => changeArgumentKind(index, event.target.value as CekArgumentKind)}>
                          {argumentKinds.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
                        </select>
                        <ChevronDown size={12} />
                      </span>
                      {argument.kind === 'bool' ? (
                        <span className="argument-value select-wrap">
                          <select value={argument.value} aria-label={`Argument ${index + 1} value`} onChange={(event) => updateArgument(index, { value: event.target.value })}>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                          <ChevronDown size={12} />
                        </span>
                      ) : (
                        <input
                          aria-label={`Argument ${index + 1} value`}
                          disabled={argument.kind === 'unit'}
                          onChange={(event) => updateArgument(index, { value: event.target.value })}
                          placeholder={argumentPlaceholders[argument.kind]}
                          spellCheck={false}
                          value={argument.value}
                        />
                      )}
                      <button className="remove-argument" type="button" aria-label={`Remove argument ${index + 1}`} onClick={() => removeArgument(index)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="run-actions">
                  <span>{program ? `${program.byteLength.toLocaleString()} byte Flat program` : 'Compile a program before running it'}</span>
                  <button className="run-button" type="button" disabled={!program || runtimeState !== 'ready'} onClick={() => void runEvaluation()}>
                    {runtimeState === 'evaluating' ? <LoaderCircle size={14} /> : <Play size={14} />}
                    Run CEK machine
                  </button>
                </div>
              </section>

              <section className="evaluation-panel" aria-live="polite">
                <header className="section-heading">
                  <span>
                    <strong>Evaluation result</strong>
                    <small>Plinth CEK · default cost model</small>
                  </span>
                  {evaluation ? (
                    <span className={`outcome-badge ${evaluation.succeeded ? 'success' : 'failure'}`}>
                      {evaluation.succeeded ? <Check size={11} /> : null}
                      {evaluation.succeeded ? 'Success' : 'Machine failure'}
                    </span>
                  ) : null}
                </header>

                {evaluation ? (
                  <>
                    <div className="budget-grid">
                      <div><span>CPU</span><strong>{formatNumber(evaluation.budget.cpu)}</strong><small>picoseconds</small></div>
                      <div><span>Memory</span><strong>{formatNumber(evaluation.budget.memory)}</strong><small>words</small></div>
                      <div><span>Elapsed</span><strong>{evaluation.elapsedMs < 1000 ? Math.round(evaluation.elapsedMs) : (evaluation.elapsedMs / 1000).toFixed(1)}</strong><small>{evaluation.elapsedMs < 1000 ? 'milliseconds' : 'seconds'}</small></div>
                      <div><span>Traces</span><strong>{evaluation.logs.length}</strong><small>emitted</small></div>
                    </div>
                    <div className="machine-result">
                      <span>{evaluation.succeeded ? 'Reduced UPLC' : 'Evaluation error'}</span>
                      <pre data-failure={!evaluation.succeeded}>{evaluation.succeeded ? evaluation.value : evaluation.error}</pre>
                    </div>
                    {evaluation.logs.length > 0 ? (
                      <div className="trace-output">
                        <span>Trace log</span>
                        <ol>{evaluation.logs.map((log, index) => <li key={`${index}-${log}`}>{log}</li>)}</ol>
                      </div>
                    ) : null}
                  </>
                ) : evaluationError ? (
                  <div className="evaluation-empty error"><strong>Runner error</strong><span>{evaluationError}</span></div>
                ) : (
                  <div className="evaluation-empty">
                    <span className="play-mark"><Play size={19} /></span>
                    <strong>{program ? 'Ready to evaluate' : 'Compile first'}</strong>
                    <span>{program ? 'Set the arguments above, then run the real CEK machine in this browser.' : 'Your compiled Flat UPLC will appear here ready to run.'}</span>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <>
              <div className="result-heading">
                <span><Terminal size={13} />{activeTab === 'uplc' ? 'Plinth compiler output' : activeTab === 'flat' ? 'Flat-encoded program' : 'Build messages'}</span>
                {program ? <small>{program.byteLength.toLocaleString()} bytes</small> : null}
              </div>
              <pre className="compiler-output" data-empty={!program && activeTab !== 'diagnostics'}>{textOutput}</pre>
            </>
          )}

          <footer className="result-status">
            <span className="status-dot" data-state={runtimeState} />
            <span>{runtimeDetail}</span>
            {program ? <span className="result-ok"><Check size={11} /> local browser runtime</span> : null}
          </footer>
        </section>
      </section>

      <footer className="app-statusbar">
        <span>Plinth 1.66</span>
        <span>GHC 9.12.4</span>
        <span>CEK · WASI</span>
        <span className="status-spacer" />
        <span>Share links use URL fragments · execution stays in this browser</span>
      </footer>
    </main>
  );
}
