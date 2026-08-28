export type OutputKind = 'stdout' | 'stderr';
export type OutputListener = (kind: OutputKind, message: string) => void;
export type ProgressListener = (progress: number, detail: string) => void;

export type CompiledProgram = {
  filename: string;
  byteLength: number;
  flatHex: string;
  uplc: string;
};

export type CompileResult = {
  elapsedMs: number;
  programs: CompiledProgram[];
};

export type BrowserCompiler = {
  compile: (source: string, listener: OutputListener) => Promise<CompileResult>;
};

type WorkerEvent =
  | { type: 'progress'; progress: number; detail: string }
  | { type: 'ready' }
  | { type: 'output'; requestId: number; kind: OutputKind; message: string }
  | { type: 'result'; requestId: number; result: CompileResult }
  | { type: 'error'; requestId?: number; message: string };

type PendingCompile = {
  listener: OutputListener;
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
};

let compilerPromise: Promise<BrowserCompiler> | null = null;

export function loadBrowserCompiler(onProgress: ProgressListener) {
  compilerPromise ??= new Promise<BrowserCompiler>((resolve, reject) => {
    const worker = new Worker(new URL('./compiler.worker.ts', import.meta.url), {
      type: 'module',
      name: 'plinth-browser-compiler',
    });
    const pending = new Map<number, PendingCompile>();
    let nextRequestId = 1;
    let initialized = false;

    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.progress, message.detail);
        return;
      }
      if (message.type === 'ready') {
        initialized = true;
        resolve({
          compile(source, listener) {
            const requestId = nextRequestId++;
            return new Promise<CompileResult>((resolveCompile, rejectCompile) => {
              pending.set(requestId, {
                listener,
                resolve: resolveCompile,
                reject: rejectCompile,
              });
              worker.postMessage({ type: 'compile', requestId, source });
            });
          },
        });
        return;
      }
      if (message.type === 'output') {
        pending.get(message.requestId)?.listener(message.kind, message.message);
        return;
      }
      if (message.type === 'result') {
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        request?.resolve(message.result);
        return;
      }
      if (message.type === 'error') {
        if (message.requestId !== undefined) {
          const request = pending.get(message.requestId);
          pending.delete(message.requestId);
          request?.reject(new Error(message.message));
        } else if (!initialized) {
          reject(new Error(message.message));
        }
      }
    };

    worker.onerror = (event) => {
      const error = new Error(event.message || 'The Plinth compiler worker stopped');
      if (!initialized) reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
  });

  return compilerPromise;
}
