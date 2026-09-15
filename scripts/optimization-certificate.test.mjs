import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { strToU8, strFromU8, unzipSync } from 'fflate';
import { packageOptimizationCertificates } from '../app/optimization-certificate.ts';

const directory = 'main_Main-example.agda-cert';
function inputs() {
  return {
    files: {
      [`${directory}/plinth-certifier-PASS.txt`]: strToU8(''),
      [`${directory}/main_Main.agda-lib`]: strToU8('include: src'),
      [`${directory}/src/main_Main.agda`]: strToU8('module main_Main where\ncertificate : Certificate trace\n'),
    },
    sources: { 'Main.hs': strToU8('module Main where\n-- λ') },
    programs: [{ filename: './Main1.uplc-flat', flatHex: '010203', uplc: '(program 1.1.0 (con integer 1))' }],
    flags: 'certify certified-opts-only',
    runtimeVersion: 'test-runtime',
  };
}

test('download retains certificate bytes, source, Flat output, and matching hashes', async () => {
  const input = inputs();
  const result = await packageOptimizationCertificates(input);
  assert.equal(result.status, 'passed');
  const zip = unzipSync(result.archive.bytes);
  assert.deepEqual(zip[`certificates/${directory}/src/main_Main.agda`], input.files[`${directory}/src/main_Main.agda`]);
  assert.equal(strFromU8(zip['source/Main.hs']), 'module Main where\n-- λ');
  assert.deepEqual(zip['programs/Main1.uplc-flat'], new Uint8Array([1, 2, 3]));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  assert.equal(manifest.compiler.runtimeVersion, input.runtimeVersion);
  for (const [path, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(zip[path]).digest('hex'), hash, path);
  }
});

test('FAIL takes precedence over PASS and preserves its report', async () => {
  const input = inputs();
  input.files[`${directory}/plinth-certifier-FAIL.txt`] = strToU8('Inline counterexample');
  const result = await packageOptimizationCertificates(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.projects[0].message, 'Inline counterexample');
  assert.ok(result.archive);
});

test('an absent project or a PASS marker without proof files is not certified', async () => {
  const input = inputs();
  const empty = await packageOptimizationCertificates({ ...input, files: {} });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.archive, undefined);
  delete input.files[`${directory}/src/main_Main.agda`];
  assert.equal((await packageOptimizationCertificates(input)).status, 'unavailable');
});

test('unsupported passes in a PASS project are marked partial', async () => {
  const input = inputs();
  input.files[`${directory}/src/main_Main.agda`] = strToU8('trace = a ∷[ inj₁ constantFoldingT , hints ] singleton b\ncertificate : Certificate trace');
  assert.equal((await packageOptimizationCertificates(input)).status, 'partial');
});

test('all projects are retained; a failing project makes the bundle fail', async () => {
  const input = inputs();
  input.files['main_Helper-example.agda-cert/plinth-certifier-FAIL.txt'] = strToU8('Failure');
  const result = await packageOptimizationCertificates(input);
  assert.equal(result.projects.length, 2);
  assert.equal(result.status, 'failed');
});

test('archive paths cannot escape their bundle directories', async () => {
  const input = inputs();
  input.sources['../Main.hs'] = strToU8('bad path');
  await assert.rejects(packageOptimizationCertificates(input), /Invalid certificate archive path/);
});
