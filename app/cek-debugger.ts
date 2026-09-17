export type SourceSpan = {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};
export type DebugReference = { ref: number; label: string };
export type DebugObject = { kind: string; text?: string; spans?: SourceSpan[]; children: DebugReference[] };
export type Breakpoint = { file: string; line: number };
export type DebugSnapshot = {
  epoch: number;
  step: number;
  phase: 'starting' | 'computing' | 'returning' | 'terminated' | 'failed';
  done: boolean;
  control: DebugReference | null;
  environment: DebugReference | null;
  frames: { kind: string; spans: SourceSpan[]; fields: DebugReference[] }[];
  spans: SourceSpan[];
  budget: { cpu: string; memory: string };
  remaining: { cpu: string; memory: string };
  logs: string[];
  result: string | null;
  failure: string | null;
};
export type DebugCommand =
  | { op: 'start'; filename: string; args: string[] }
  | { op: 'step'; count: number; source?: boolean; breakpoints?: Breakpoint[] }
  | { op: 'inspect'; epoch: number; ref: number }
  | { op: 'stop' };

// GHC spans use 1-based Unicode columns, exclusive end positions, and
// tab stops of eight. CodeMirror offsets are UTF-16, not code-point indices.
export function spanOffsets(source: string, span: SourceSpan) {
  const lines = source.split('\n');
  const position = (line: number, column: number) => {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || line > lines.length || column < 1) return null;
    let offset = lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0);
    let col = 1;
    for (const character of lines[line - 1]) {
      if (col >= column) break;
      col = character === '\t' ? col + 8 - ((col - 1) % 8) : col + 1;
      offset += character.length;
    }
    return col === column ? offset : null;
  };
  const from = position(span.startLine, span.startColumn);
  const to = position(span.endLine, span.endColumn);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

export function projectSpans(spans: SourceSpan[], modules: { name: string; source: string }[]) {
  return spans.filter((span) => {
    const sourceModule = modules.find((item) => item.name === span.file);
    return sourceModule && spanOffsets(sourceModule.source, span);
  }).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine)
    || (a.endColumn - a.startColumn) - (b.endColumn - b.startColumn)
    || a.file.localeCompare(b.file) || a.startLine - b.startLine || a.startColumn - b.startColumn);
}
