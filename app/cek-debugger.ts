export type SourceSpan = {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};
export type DebugReference = { ref: number; label: string; preview?: string; name?: string; index?: number };
export type DebugObject = { kind: string; text?: string; spans?: SourceSpan[]; focusSpans?: SourceSpan[]; children: DebugReference[] };
export type Breakpoint = { file: string; line: number };
export type DebugSnapshot = {
  epoch: number;
  step: number;
  history: { first: number; last: number; limit: number };
  phase: 'starting' | 'computing' | 'returning' | 'terminated' | 'failed';
  done: boolean;
  control: DebugReference | null;
  environment: DebugReference | null;
  frames: { kind: string; summary?: string; spans: SourceSpan[]; focusSpans?: SourceSpan[]; fields: DebugReference[] }[];
  spans: SourceSpan[];
  focusSpans?: SourceSpan[];
  action?: string;
  budget: { cpu: string; memory: string };
  remaining: { cpu: string; memory: string };
  logs: string[];
  result: string | null;
  failure: string | null;
};
export type DebugCommand =
  | { op: 'start'; filename: string; args: string[] }
  | { op: 'step'; count: number; source?: boolean; breakpoints?: Breakpoint[] }
  | { op: 'back'; count?: number }
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

// The WASM adapter identifies spans introduced at this node, separately from
// inherited enclosing spans. Never decide call sites by source-text matching
// or by arbitrarily reversing the line-number tie-breaker.
export function focusedProjectSpans(location: { spans: SourceSpan[]; focusSpans?: SourceSpan[] }, modules: { name: string; source: string }[]) {
  const focus = projectSpans(location.focusSpans ?? [], modules);
  const seen = new Set(focus.map((span) => JSON.stringify(span)));
  return [...focus, ...projectSpans(location.spans, modules).filter((span) => !seen.has(JSON.stringify(span)))];
}

// Display every location carried by the current state and its continuation.
// Focused spans are only for navigation/source stepping, never a paint filter.
export function debugSourceSpans(snapshot: Pick<DebugSnapshot, 'spans' | 'frames'>, modules: { name: string; source: string }[]) {
  const seen = new Set<string>();
  return projectSpans([...snapshot.spans, ...snapshot.frames.flatMap((frame) => frame.spans)], modules).filter((span) => {
    const key = JSON.stringify([span.file, span.startLine, span.startColumn, span.endLine, span.endColumn]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Union overlapping ranges to avoid nested marks obscuring one another.
// Invalid spans are rejected, never clamped to unrelated text.
export function sourceHighlightRanges(source: string, spans: SourceSpan[]) {
  const ranges = spans.map((span) => spanOffsets(source, span))
    .filter((range): range is { from: number; to: number } => range !== null)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}
