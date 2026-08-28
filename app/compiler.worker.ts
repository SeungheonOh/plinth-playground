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
  '-package=plinth-browser-utils',
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
  format: string;
  version?: string;
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
  const manifestResponse = await fetch(`${RUNTIME}/rootfs-manifest.json`, {
    cache: 'no-cache',
  });
  if (!manifestResponse.ok) {
    throw new Error(`Runtime manifest failed (${manifestResponse.status})`);
  }
  const manifest = await manifestResponse.json() as RuntimeManifest;
  let received = 0;

  const downloadPart = async ({ file, size }: RuntimeManifest['parts'][number]) => {
    const version = manifest.version
      ? `?v=${encodeURIComponent(manifest.version)}`
      : '';
    const response = await fetch(`${RUNTIME}/${file}${version}`);
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

  const parts = await Promise.all(manifest.parts.map(downloadPart));
  const archive = new Uint8Array(manifest.totalSize);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return { archive, format: manifest.format };
}

const tarTextDecoder = new TextDecoder();

function decodeTarString(bytes: Uint8Array) {
  const nul = bytes.indexOf(0);
  return tarTextDecoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

function parseTarSize(bytes: Uint8Array) {
  const value = decodeTarString(bytes).trim();
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function parsePaxPath(bytes: Uint8Array) {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(32, offset);
    if (space === -1) break;
    const length = Number.parseInt(tarTextDecoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length < 1 || offset + length > bytes.byteLength) break;
    const record = tarTextDecoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const separator = record.indexOf('=');
    if (separator !== -1 && record.slice(0, separator) === 'path') {
      path = record.slice(separator + 1);
    }
    offset += length;
  }
  return path;
}

function addRootfsFile(path: string, data: Uint8Array) {
  const parts = path
    .replace(/^\.\//, '')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new Error(`Unsafe runtime archive path: ${path}`);
  }

  const filename = parts.pop()!;
  let directory = rootfs.dir;
  for (const part of parts) {
    const existing = directory.contents.get(part);
    if (existing instanceof Directory) {
      directory = existing;
    } else if (existing) {
      throw new Error(`Runtime archive path is not a directory: ${path}`);
    } else {
      const child = new Directory(new Map());
      directory.contents.set(part, child);
      directory = child;
    }
  }

  const file = new File(new Uint8Array(), { readonly: true });
  file.data = data;
  directory.contents.set(filename, file);
  return filename.endsWith('.so')
    ? `/${parts.join('/')}`.replace(/\/$/, '') || '/'
    : null;
}

async function extractGzipTar(archive: Uint8Array) {
  const stream = new Blob([archive])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const tarBytes = new Uint8Array(await new Response(stream).arrayBuffer());
  postProgress(88, 'Indexing the GHC and Plinth filesystem');

  const sharedLibraryDirectories = new Set<string>();
  let pendingPath: string | undefined;
  for (let offset = 0; offset + 512 <= tarBytes.byteLength;) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = parseTarSize(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('Invalid file size in runtime archive');
    }
    const dataOffset = offset + 512;
    const dataEnd = dataOffset + size;
    if (dataEnd > tarBytes.byteLength) throw new Error('Truncated runtime archive');

    const type = String.fromCharCode(header[156]);
    const name = decodeTarString(header.subarray(0, 100));
    const prefix = decodeTarString(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const data = tarBytes.subarray(dataOffset, dataEnd);

    if (type === 'x') {
      pendingPath = parsePaxPath(data) ?? pendingPath;
    } else if (type === 'L') {
      pendingPath = decodeTarString(data);
    } else if (type === '0' || type === '\0') {
      const directory = addRootfsFile(pendingPath ?? headerPath, data);
      if (directory) sharedLibraryDirectories.add(directory);
      pendingPath = undefined;
    } else if (type === '5') {
      pendingPath = undefined;
    } else if (type !== 'g') {
      throw new Error(`Unsupported runtime archive entry type: ${type}`);
    }

    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return [...sharedLibraryDirectories];
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
  postProgress(1, 'Starting isolated compiler worker');
  const [runtimeArchive, linker, compiledDecoder] = await Promise.all([
    fetchRuntimeArchive(),
    import(/* @vite-ignore */ `${RUNTIME}/dyld.mjs`) as Promise<DynamicLinkerModule>,
    WebAssembly.compileStreaming(fetch(`${RUNTIME}/decode-uplc.wasm`)),
  ]);
  decoderModule = compiledDecoder;

  let searchDirs: string[];
  if (
    runtimeArchive.format.endsWith('.tar.gz') &&
    typeof DecompressionStream !== 'undefined'
  ) {
    postProgress(82, 'Decompressing GHC and Plinth in memory');
    searchDirs = await extractGzipTar(runtimeArchive.archive);
  } else {
    const tarWasi = new WASI(
      ['bsdtar.wasm', '-x', '-m'],
      [],
      [
        new OpenFile(new File(runtimeArchive.archive, { readonly: true })),
        ConsoleStdout.lineBuffered(() => undefined),
        ConsoleStdout.lineBuffered((message) => console.warn(message)),
        rootfs,
      ],
      { debug: false },
    );
    const { instance: tarInstance } = await WebAssembly.instantiateStreaming(
      fetch(`${RUNTIME}/bsdtar.wasm`),
      { wasi_snapshot_preview1: tarWasi.wasiImport },
    );
    postProgress(82, 'Unpacking GHC and Plinth in memory');
    tarWasi.start(tarInstance as unknown as WasiInstance);
    searchDirs = collectSharedLibraryDirectories(rootfs.dir);
  }

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
    searchDirs,
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
