import PlinthCompilerWorker from './compiler.worker.ts?worker';

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

export type CekArgumentKind = 'integer' | 'bytes' | 'string' | 'bool' | 'unit' | 'data';

export type CekArgument = {
  kind: CekArgumentKind;
  value: string;
};

export type CekEvaluationResult = {
  elapsedMs: number;
  succeeded: boolean;
  value: string;
  error?: string;
  budget: {
    cpu: string;
    memory: string;
  };
  logs: string[];
};

export type BrowserCompiler = {
  compile: (source: string, listener: OutputListener) => Promise<CompileResult>;
  evaluate: (filename: string, args: CekArgument[]) => Promise<CekEvaluationResult>;
};

type WorkerEvent =
  | { type: 'progress'; progress: number; detail: string }
  | { type: 'ready' }
  | { type: 'output'; requestId: number; kind: OutputKind; message: string }
  | { type: 'compile-result'; requestId: number; result: CompileResult }
  | { type: 'evaluate-result'; requestId: number; result: CekEvaluationResult }
  | { type: 'error'; requestId?: number; message: string };

type PendingCompile = {
  listener: OutputListener;
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
};

type PendingEvaluation = {
  resolve: (result: CekEvaluationResult) => void;
  reject: (error: Error) => void;
};

let compilerPromise: Promise<BrowserCompiler> | null = null;

export function loadBrowserCompiler(onProgress: ProgressListener) {
  compilerPromise ??= new Promise<BrowserCompiler>((resolve, reject) => {
    const worker = new PlinthCompilerWorker({
      name: 'plinth-browser-compiler',
    });
    const pending = new Map<number, PendingCompile>();
    const pendingEvaluations = new Map<number, PendingEvaluation>();
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
          evaluate(filename, args) {
            const requestId = nextRequestId++;
            return new Promise<CekEvaluationResult>((resolveEvaluation, rejectEvaluation) => {
              pendingEvaluations.set(requestId, {
                resolve: resolveEvaluation,
                reject: rejectEvaluation,
              });
              worker.postMessage({ type: 'evaluate', requestId, filename, args });
            });
          },
        });
        return;
      }
      if (message.type === 'output') {
        pending.get(message.requestId)?.listener(message.kind, message.message);
        return;
      }
      if (message.type === 'compile-result') {
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        request?.resolve(message.result);
        return;
      }
      if (message.type === 'evaluate-result') {
        const request = pendingEvaluations.get(message.requestId);
        pendingEvaluations.delete(message.requestId);
        request?.resolve(message.result);
        return;
      }
      if (message.type === 'error') {
        if (message.requestId !== undefined) {
          const request = pending.get(message.requestId);
          const evaluation = pendingEvaluations.get(message.requestId);
          pending.delete(message.requestId);
          pendingEvaluations.delete(message.requestId);
          request?.reject(new Error(message.message));
          evaluation?.reject(new Error(message.message));
        } else if (!initialized) {
          reject(new Error(message.message));
        }
      }
    };

    worker.onerror = (event) => {
      const error = new Error(event.message || 'The Plinth compiler worker stopped');
      if (!initialized) reject(error);
      for (const request of pending.values()) request.reject(error);
      for (const request of pendingEvaluations.values()) request.reject(error);
      pending.clear();
      pendingEvaluations.clear();
    };
  });

  return compilerPromise;
}
