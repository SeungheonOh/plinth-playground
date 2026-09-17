import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spanOffsets, projectSpans } from '../app/cek-debugger.ts';
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
