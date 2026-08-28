/// <reference lib="webworker" />

import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from '@bjorn3/browser_wasi_shim';
import type { CompileResult, CompiledProgram, OutputKind } from './compiler-runtime';

const GHC_VERSION = '9.12.4.20260731';
const GHC_PREFIX = '/home/sho/fun/ghc-wasm-toolchain-9.12';
const LIBDIR = `${GHC_PREFIX}/wasm32-wasi-ghc/lib`;
const STORE_PACKAGE_DB =
  `${GHC_PREFIX}/.cabal/store/ghc-${GHC_VERSION}-inplace/package.db`;
const PROJECT_PACKAGE_DB =
  '/home/sho/fun/ghc-plinth-wasm-playground/compiler-experiment/' +
  `dist-uplc-ghc-wasm-9.12/packagedb/ghc-${GHC_VERSION}`;
const RUNTIME = '/runtime';

const PLINTH_FLAGS = [
  '-package=plutus-tx',
  '-i/tmp/modules',
  '-fplugin-opt=Plinth.Plugin:dump-uplc',
  '-Wno-missed-extra-shared-lib',
  '-v1',
  '-fno-full-laziness',
  '-fno-ignore-interface-pragmas',
  '-fno-omit-interface-pragmas',
  '-fno-spec-constr',
  '-fno-specialise',
  '-fno-strictness',
  '-fno-unbox-small-strict-fields',
  '-fno-unbox-strict-fields',
  '-fforce-recomp',
  '-fno-code',
].join(' ');

type CompileFunction = (args: string, source: string) => Promise<string>;
type WasiInstance = Parameters<WASI['start']>[0];

type RuntimeManifest = {
  totalSize: number;
  parts: Array<{ file: string; size: number }>;
};

type DynamicLinkerModule = {
  DyLDBrowserHost: new (options: {
    rootfs: PreopenDirectory;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  }) => {
    findSystemLibrary(filename: string): Promise<string>;
  };
  main: (options: {
    rpc: unknown;
    searchDirs: string[];
    mainSoPath: string;
    args: string[];
    isIserv: boolean;
  }) => Promise<{
    exportFuncs: {
      uplcGhcBrowser: (
        libdir: string,
        packagePath: string,
      ) => Promise<CompileFunction>;
    };
  }>;
};

let activeRequestId: number | null = null;
let compileFunction: CompileFunction;
let decoderModule: WebAssembly.Module;
let rootfs: PreopenDirectory;

function postProgress(progress: number, detail: string) {
  self.postMessage({ type: 'progress', progress, detail });
}

function postOutput(kind: OutputKind, message: string) {
  if (activeRequestId === null) return;
  self.postMessage({ type: 'output', requestId: activeRequestId, kind, message });
}

async function fetchRuntimeArchive() {
  const manifestResponse = await fetch(`${RUNTIME}/rootfs-manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(`Runtime manifest failed (${manifestResponse.status})`);
  }
  const manifest = await manifestResponse.json() as RuntimeManifest;
  let received = 0;

  const downloadPart = async ({ file, size }: RuntimeManifest['parts'][number]) => {
    const response = await fetch(`${RUNTIME}/${file}`);
    if (!response.ok) throw new Error(`Runtime download failed (${response.status})`);
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      received += bytes.byteLength;
      return bytes;
    }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
    let partReceived = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      partReceived += value.byteLength;
      received += value.byteLength;
      postProgress(
        Math.min(78, Math.round((received / manifest.totalSize) * 78)),
        `Downloading Plinth compiler · ${(received / 1_048_576).toFixed(0)} / ${(manifest.totalSize / 1_048_576).toFixed(0)} MB`,
      );
    }

    const bytes = new Uint8Array(partReceived || size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  const parts = [];
  for (const part of manifest.parts) parts.push(await downloadPart(part));
  const archive = new Uint8Array(manifest.totalSize);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
}

function collectSharedLibraryDirectories(directory: Directory) {
  const directories = new Set<string>();

  const visit = (current: Directory, currentPath: string) => {
    for (const [name, entry] of current.contents) {
      const entryPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
      if (entry instanceof Directory) {
        visit(entry, entryPath);
      } else if (name.endsWith('.so')) {
        directories.add(currentPath);
      }
    }
  };

  visit(directory, '/');
  return [...directories];
}

async function decodeProgram(filename: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoderWasi = new WASI(
    ['decode-uplc.wasm', filename],
    [],
    [
      new OpenFile(new File(new Uint8Array(), { readonly: true })),
      ConsoleStdout.lineBuffered((message) => stdout.push(message)),
      ConsoleStdout.lineBuffered((message) => stderr.push(message)),
      rootfs,
    ],
    { debug: false },
  );
  const instance = await WebAssembly.instantiate(decoderModule, {
    wasi_snapshot_preview1: decoderWasi.wasiImport,
  });
  decoderWasi.start(instance as unknown as WasiInstance);
  if (stderr.length > 0) throw new Error(stderr.join('\n'));
  return stdout.join('\n').trim();
}

async function initialize() {
  rootfs = new PreopenDirectory('/', new Map());
  const tarWasi = new WASI(
    ['bsdtar.wasm', '-x'],
    [],
    [
      new OpenFile(new File(new Uint8Array(), { readonly: true })),
      ConsoleStdout.lineBuffered(() => undefined),
      ConsoleStdout.lineBuffered((message) => console.warn(message)),
      rootfs,
    ],
    { debug: false },
  );

  postProgress(1, 'Starting isolated compiler worker');
  const [{ instance: tarInstance }, rootfsBytes, linker, compiledDecoder] =
    await Promise.all([
      WebAssembly.instantiateStreaming(fetch(`${RUNTIME}/bsdtar.wasm`), {
        wasi_snapshot_preview1: tarWasi.wasiImport,
      }),
      fetchRuntimeArchive(),
      import(/* @vite-ignore */ `${RUNTIME}/dyld.mjs`) as Promise<DynamicLinkerModule>,
      WebAssembly.compileStreaming(fetch(`${RUNTIME}/decode-uplc.wasm`)),
    ]);
  decoderModule = compiledDecoder;

  postProgress(82, 'Unpacking GHC and Plinth in memory');
  tarWasi.fds[0] = new OpenFile(new File(rootfsBytes, { readonly: true }));
  tarWasi.start(tarInstance as unknown as WasiInstance);

  postProgress(91, 'Linking the Plinth compiler');
  class PlinthBrowserHost extends linker.DyLDBrowserHost {
    override findSystemLibrary(filename: string) {
      const mapped = {
        'liblibwasi-emulated-mman.so': 'libuplc-ghc-empty.so',
        'liblibdl.so': 'libuplc-ghc-empty.so',
      }[filename] ?? filename;
      return super.findSystemLibrary(mapped);
    }
  }

  const dynamicLinker = await linker.main({
    rpc: new PlinthBrowserHost({
      rootfs,
      stdout: (message) => postOutput('stdout', message),
      stderr: (message) => postOutput('stderr', message),
    }),
    searchDirs: collectSharedLibraryDirectories(rootfs.dir),
    mainSoPath: '/tmp/libuplc-ghc-browser.so',
    args: ['libuplc-ghc-browser.so', '+RTS', '-K512m', '-RTS'],
    isIserv: false,
  });

  compileFunction = await dynamicLinker.exportFuncs.uplcGhcBrowser(
    LIBDIR,
    `${STORE_PACKAGE_DB}:${PROJECT_PACKAGE_DB}:`,
  );
  postProgress(100, 'Plinth compiler ready');
  self.postMessage({ type: 'ready' });
}

self.onmessage = async (
  event: MessageEvent<{ type: 'compile'; requestId: number; source: string }>,
) => {
  if (event.data.type !== 'compile') return;
  const { requestId, source } = event.data;
  activeRequestId = requestId;
  const startedAt = performance.now();

  try {
    const encodedOutputs = await compileFunction(PLINTH_FLAGS, source);
    const programs: CompiledProgram[] = [];
    for (const record of encodedOutputs.trim().split('\n')) {
      const [filename, flatHex] = record.split('\t');
      if (!filename || !flatHex || flatHex.length % 2 !== 0) {
        throw new Error(`Invalid compiler output record: ${record}`);
      }
      programs.push({
        filename,
        flatHex,
        byteLength: flatHex.length / 2,
        uplc: await decodeProgram(filename),
      });
    }
    const result: CompileResult = {
      elapsedMs: performance.now() - startedAt,
      programs,
    };
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : 'Compilation failed',
    });
  } finally {
    activeRequestId = null;
  }
};

initialize().catch((error) => {
  self.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : 'Compiler initialization failed',
  });
});
