import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spanOffsets, projectSpans, focusedProjectSpans, debugSourceSpans, sourceHighlightRanges } from '../app/cek-debugger.ts';
import { encodeCekArgument } from '../app/cek-arguments.ts';

test('source spans map exact expressions with exclusive end columns', () => {
  const source = 'module Main where\naddOne x = x + 1';
  const span = { file: 'Main.hs', startLine: 2, startColumn: 12, endLine: 2, endColumn: 13 };
  const { from, to } = spanOffsets(source, span);
  assert.equal(source.slice(from, to), 'x');
});
test('GHC Unicode/tab columns map to CodeMirror UTF-16 offsets', () => {
  const source = '\tα😀x\nnext';
  const span = { file: 'Main.hs', startLine: 1, startColumn: 9, endLine: 1, endColumn: 11 };
  const { from, to } = spanOffsets(source, span);
  assert.equal(source.slice(from, to), 'α😀');
  assert.deepEqual(spanOffsets(source, { ...span, startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }), { from: 6, to: 10 });
});
test('invalid spans are not silently clamped to unrelated source', () => {
  const span = { file: 'Main.hs', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
  for (const change of [{ startLine: 0 }, { endLine: 2 }, { endColumn: 10 }, { startColumn: 0 }, { endColumn: 1 }]) {
    assert.equal(spanOffsets('x', { ...span, ...change }), null);
  }
});
test('prefer granular project spans while excluding unavailable library locations', () => {
  const broad = { file: 'Main.hs', startLine: 1, startColumn: 1, endLine: 1, endColumn: 8 };
  const narrow = { ...broad, startColumn: 3, endColumn: 4 };
  assert.deepEqual(projectSpans([broad, { ...narrow, file: 'Library.hs' }, narrow], [{ name: 'Main.hs', source: 'f x = x' }]), [narrow, broad]);
});
test('Run and Debug share exact typed-argument encodings', () => {
  assert.equal(encodeCekArgument({ kind: 'integer', value: ' -42 ' }), 'integer:-42');
  assert.equal(encodeCekArgument({ kind: 'bytes', value: '0x ab CD' }), 'bytes:abCD');
  assert.equal(encodeCekArgument({ kind: 'string', value: 'λ' }), 'string:cebb');
  assert.equal(encodeCekArgument({ kind: 'data', value: 'I 42' }), 'data:49203432');
  assert.equal(encodeCekArgument({ kind: 'bool', value: 'TRUE' }), 'bool:true');
  assert.equal(encodeCekArgument({ kind: 'unit', value: '' }), 'unit');
});

test('node-specific recursive-use spans precede inherited definition spans', () => {
  const source = 'fibonacci n\n  | otherwise = fibonacci (n - 1) + fibonacci (n - 2)';
  const definition = { file: 'Main.hs', startLine: 1, endLine: 1, startColumn: 1, endColumn: 10 };
  const left = { file: 'Main.hs', startLine: 2, endLine: 2, startColumn: 17, endColumn: 26 };
  const right = { ...left, startColumn: 37, endColumn: 46 };
  const modules = [{ name: 'Main.hs', source }];
  for (const call of [left, right]) {
    assert.deepEqual(focusedProjectSpans({ spans: [definition, call], focusSpans: [call] }, modules), [call, definition]);
    const range = spanOffsets(source, call);
    assert.equal(source.slice(range.from, range.to), 'fibonacci');
  }
});
test('generated states stay unmapped and unavailable focused spans safely fall back', () => {
  const source = 'f x = x';
  const span = { file: 'Main.hs', startLine: 1, endLine: 1, startColumn: 7, endColumn: 8 };
  const modules = [{ name: 'Main.hs', source }];
  assert.deepEqual(focusedProjectSpans({ spans: [], focusSpans: [] }, modules), []);
  assert.deepEqual(focusedProjectSpans({ spans: [span], focusSpans: [{ ...span, file: 'Library.hs' }] }, modules), [span]);
  assert.deepEqual(focusedProjectSpans({ spans: [span] }, modules), [span]);
});

test('highlight every state and continuation span, across modules, without duplicates', () => {
  const modules = [{ name: 'Main.hs', source: 'f x = g x' }, { name: 'Helper.hs', source: 'g y = y' }];
  const definition = { file: 'Main.hs', startLine: 1, endLine: 1, startColumn: 1, endColumn: 2 };
  const call = { ...definition, startColumn: 7, endColumn: 8 };
  const saved = { ...definition, file: 'Helper.hs' };
  const spans = debugSourceSpans({ spans: [definition, call], frames: [{ spans: [definition, saved] }, { spans: [saved, { ...saved, file: 'Unavailable.hs' }] }] }, modules);
  assert.equal(spans.length, 3);
  for (const span of [definition, call, saved]) assert.ok(spans.some((actual) => JSON.stringify(actual) === JSON.stringify(span)));
  assert.deepEqual(debugSourceSpans({ spans: [], frames: [{ spans: [saved] }] }, modules), [saved], 'An unannotated control still shows its saved continuation source');
  assert.deepEqual(debugSourceSpans({ spans: [], frames: [] }, modules), [], 'Never carry stale highlights into an unrelated state');
});
test('render disjoint spans together and merge overlaps without losing covered text', () => {
  const source = 'fibonacci n\n  | otherwise = fibonacci (n - 1)';
  const definition = { file: 'Main.hs', startLine: 1, endLine: 1, startColumn: 1, endColumn: 10 };
  const call = { ...definition, startLine: 2, endLine: 2, startColumn: 17, endColumn: 26 };
  assert.deepEqual(sourceHighlightRanges(source, [call, definition, call]).map(({ from, to }) => source.slice(from, to)), ['fibonacci', 'fibonacci']);
  assert.deepEqual(sourceHighlightRanges(source, [definition, { ...definition, startColumn: 5, endColumn: 12 }]), [{ from: 0, to: 11 }]);
  const multiline = { ...definition, startColumn: 11, endLine: 2, endColumn: 4 };
  assert.deepEqual(sourceHighlightRanges(source, [definition, multiline]), [{ from: 0, to: 9 }, { from: 10, to: 15 }]);
  assert.deepEqual(sourceHighlightRanges(source, [{ ...call, endLine: 90 }]), []);
  assert.deepEqual(sourceHighlightRanges(source, []), []);
});
