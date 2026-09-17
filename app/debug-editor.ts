import { StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import { spanOffsets, type SourceSpan } from './cek-debugger';

class DebugMarker extends GutterMarker {
  constructor(readonly breakpoint: boolean, readonly current: boolean) { super(); }
  toDOM() {
    const marker = document.createElement('span');
    marker.textContent = this.breakpoint ? '●' : this.current ? '→' : '·';
    marker.className = this.breakpoint ? 'debug-breakpoint-marker' : this.current ? 'debug-current-marker' : 'debug-empty-marker';
    marker.title = this.breakpoint ? 'Remove breakpoint' : 'Toggle breakpoint';
    return marker;
  }
}

export function debugEditorExtension(source: string, span: SourceSpan | null, breakpoints: number[], toggle: (line: number) => void) {
  const range = span ? spanOffsets(source, span) : null;
  const field = StateField.define<DecorationSet>({
    create: () => range ? Decoration.set([Decoration.mark({ class: 'cek-source-highlight' }).range(range.from, range.to)]) : Decoration.none,
    update: (decorations, transaction) => decorations.map(transaction.changes),
    provide: (field) => EditorView.decorations.from(field),
  });
  return [field, gutter({
    class: 'cm-debug-gutter',
    lineMarker: (view, line) => {
      const number = view.state.doc.lineAt(line.from).number;
      return new DebugMarker(breakpoints.includes(number), span?.startLine === number);
    },
    domEventHandlers: { mousedown: (view, line) => { toggle(view.state.doc.lineAt(line.from).number); return true; } },
  })];
}
