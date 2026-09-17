import { StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import { sourceHighlightRanges, type SourceSpan } from './cek-debugger';

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

export function debugEditorExtension(source: string, spans: SourceSpan[], breakpoints: number[], toggle: (line: number) => void) {
  const ranges = sourceHighlightRanges(source, spans);
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.set(ranges.map(({ from, to }) => Decoration.mark({
      class: 'cek-source-highlight',
      attributes: { 'data-source-from': String(from), 'data-source-to': String(to) },
    }).range(from, to))),
    update: (decorations, transaction) => decorations.map(transaction.changes),
    provide: (field) => EditorView.decorations.from(field),
  });
  return [field, gutter({
    class: 'cm-debug-gutter',
    lineMarker: (view, line) => {
      const number = view.state.doc.lineAt(line.from).number;
      return new DebugMarker(breakpoints.includes(number), ranges.some((range) => range.from <= line.to && range.to > line.from));
    },
    domEventHandlers: { mousedown: (view, line) => { toggle(view.state.doc.lineAt(line.from).number); return true; } },
  })];
}
