import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const output = await mkdtemp(path.join(tmpdir(), 'plinth-debugger-browser-'));
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// Test-only access to the real worker protocol; no production test endpoint.
await page.addInitScript(() => {
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      window.testCompilerWorker = this;
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'compile-result') window.testLastCompilation = data.result;
        if (data.type === 'debug-result' && 'epoch' in data.result) window.testLastDebugSnapshot = data.result;
      });
    }
  };
  let sequence = 100000;
  window.testWorkerRequest = (message) => new Promise((resolve, reject) => {
    const requestId = sequence++;
    const worker = window.testCompilerWorker;
    const output = [];
    const handler = ({ data }) => {
      if (data.requestId !== requestId) return;
      if (data.type === 'output') { output.push(data.message); return; }
      worker.removeEventListener('message', handler);
      if (data.type === 'error') reject(new Error([data.message, ...output].join('\n'))); else resolve(data.result);
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...message, requestId });
  });
});
const request = (message) => page.evaluate((message) => window.testWorkerRequest(message), message);
const debug = (command) => request({ type: 'debug', command });
const machineState = ({ epoch, history, ...state }) => state;
const waitReady = () => page.waitForFunction(() => document.querySelector('.compiler-state')?.textContent.includes('runtime ready'), null, { timeout: 240_000 });

async function compile() {
  await page.locator('.primary-button').click();
  await page.waitForFunction(() => document.querySelector('.compiler-state')?.textContent.includes('compiling'));
  await waitReady();
  console.log('Browser compiler ready');
  if (!await page.locator('.certification-result').count()) throw new Error(await page.locator('.result-pane').innerText());
}
async function replaceSource(source) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(source);
}

async function checkMachine(filename, args, expected) {
  let state = await debug({ op: 'start', filename, args });
  const recorded = [state];
  assert.equal(state.step, 0);
  let sawFrame = false;
  let sawEnvironment = false;
  let sawGranular = false;
  const kinds = new Set();
  const inspect = async (ref, epoch, depth = 0) => {
    const value = await debug({ op: 'inspect', epoch, ref: ref.ref });
    kinds.add(value.kind);
    if (depth < 2) for (const child of value.children) await inspect(child, epoch, depth + 1);
    return value;
  };
  for (let i = 0; i < 400 && !state.done; i++) {
    const old = state;
    state = await debug({ op: 'step', count: 1 });
    recorded.push(state);
    assert.equal(state.step, old.step + 1, 'Every click must execute exactly one CEK transition');
    if (old.control) await assert.rejects(() => debug({ op: 'inspect', epoch: old.epoch, ref: old.control.ref }), /earlier debugger state/);
    if (state.control) await inspect(state.control, state.epoch);
    if (state.environment) {
      const env = await inspect(state.environment, state.epoch);
      sawEnvironment ||= env.children.length > 0;
    }
    for (const frame of state.frames) {
      sawFrame = true;
      for (const ref of frame.fields) await inspect(ref, state.epoch);
    }
    sawGranular ||= state.spans.some((span) => span.startLine === span.endLine && span.startColumn > 1 && span.endColumn - span.startColumn < 8);
  }
  assert.equal(state.done, true);
  assert.ok(sawFrame && sawEnvironment && sawGranular, 'Expected real stack, environment, and expression spans');
  for (let i = recorded.length - 2; i >= 0; i--) {
    const back = await debug({ op: 'back', count: 1 });
    assert.deepEqual(machineState(back), machineState(recorded[i]), `Backward state ${i} must restore the exact budget, traces, control and frames`);
    if (back.environment) await inspect(back.environment, back.epoch);
    if (back.control) await inspect(back.control, back.epoch);
  }
  for (let i = 1; i < recorded.length; i++) {
    const forward = await debug({ op: 'step', count: 1 });
    assert.deepEqual(machineState(forward), machineState(recorded[i]), `Forward history state ${i} must not repeat traces or costs`);
  }
  const arguments_ = args.map((arg) => ({ kind: arg.split(':')[0], value: arg.slice(arg.indexOf(':') + 1) }));
  const evaluated = await request({ type: 'evaluate', filename, args: arguments_ });
  assert.equal(!state.failure, evaluated.succeeded);
  if (evaluated.succeeded) {
    assert.equal(state.result, evaluated.value);
    assert.deepEqual(state.budget, evaluated.budget, 'Debugger and production evaluator budgets differ');
    assert.match(state.result, expected);
  } else { assert.match(state.failure, expected); assert.equal(state.failure, evaluated.error); }
  assert.deepEqual(state.logs, evaluated.logs);
  console.log('Differential CEK check:', { args, steps: state.step, result: state.result, failure: !!state.failure, budget: state.budget, kinds: [...kinds] });
  return state;
}

try {
  await page.goto(process.env.PLINTH_URL ?? 'http://127.0.0.1:5174/');
  await waitReady();
  await page.locator('.example-picker select').selectOption('modules');
  await compile();
  console.log('Multi-module UI compiled');
  await page.getByRole('tab', { name: 'Debug', exact: true }).click();
  await page.getByRole('button', { name: 'Start debugger', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="1"]').waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="1"]').waitFor();
  await page.keyboard.press('Shift+F10');
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  await page.keyboard.press('F10');
  await page.locator('.debug-state-bar[data-step="1"]').waitFor();
  let highlightedValue = false;
  let inspectedBindings = 0;
  for (let i = 0; i < 25; i++) {
    if (await page.locator('.debug-state-bar[data-phase="terminated"]').count()) break;
    await page.waitForFunction(() => !document.querySelector('.debug-inspector .inspector-loading'));
    const binding = page.locator('.inspector-bindings > .inspector-node').first();
    if (await binding.count()) {
      if (!inspectedBindings) await binding.locator(':scope > button').click();
      assert.equal(await binding.locator(':scope > button').getAttribute('aria-expanded'), 'true', 'Keep the binding expanded between CEK steps');
      await binding.locator('.inspector-code').waitFor();
      assert.match(await binding.locator('.inspector-code').innerText(), /con integer 40/);
      inspectedBindings++;
    }
    if ((await page.locator('.cek-source-highlight').allTextContents()).includes('value')) { highlightedValue = true; break; }
    const before = await page.locator('.debug-state-bar').getAttribute('data-step');
    await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
    await page.waitForFunction((before) => document.querySelector('.debug-state-bar')?.getAttribute('data-step') !== before, before);
  }
  assert.ok(highlightedValue, 'Must highlight LocalMath.value, not just the function declaration');
  assert.ok(inspectedBindings > 1, 'Must inspect the same expanded binding across multiple states');
  console.log('Granular cross-module highlighting verified');
  assert.match(await page.locator('.source-editor').getAttribute('aria-label').catch(() => '') ?? '', /^$|LocalMath/);
  const storedFunction = page.locator('.inspector-frame[data-top="true"] .inspector-node').first();
  await storedFunction.locator(':scope > button').click();
  await storedFunction.locator('.inspector-node-content .inspector-code').first().waitFor();
  assert.match(await storedFunction.innerText(), /addInteger/i);
  await page.screenshot({ path: path.join(output, 'source-debugger.png'), fullPage: true });
  for (const width of [1500, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.inspector-environment').scrollIntoViewIfNeeded();
    const layout = await page.locator('.inspector-environment').evaluate((element) => {
      const columns = [...element.querySelectorAll('.inspector-table-heading > span')].map((column) => column.getBoundingClientRect().left);
      const row = element.querySelector('.inspector-bindings > .inspector-node > button');
      const cells = ['.inspector-node-name', '.inspector-type', '.inspector-preview'].map((selector) => row.querySelector(selector).getBoundingClientRect().left);
      return { columns, cells, overflow: element.scrollWidth - element.clientWidth };
    });
    layout.columns.forEach((position, index) => assert.ok(Math.abs(position - layout.cells[index]) <= 1, `Misaligned environment column ${index} at ${width}px`));
    assert.ok(layout.overflow <= 1, `Environment overflow at ${width}: ${layout.overflow}`);
    const overflow = await page.locator('.debugger-panel').evaluate((element) => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `Inspector overflow at ${width}: ${overflow}`);
    await page.screenshot({ path: path.join(output, `inspector-${width}.png`), fullPage: true });
  }
  console.log('Expanded environment and frame values, persistent rows, and responsive column alignment verified');
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('.debug-state-bar[data-phase="terminated"]').waitFor();
  assert.match(await page.locator('.debugger-panel').innerText(), /con integer 42/);
  const lastStep = Number(await page.locator('.debug-state-bar').getAttribute('data-step'));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator(`.debug-state-bar[data-step="${lastStep - 1}"]`).waitFor();
  await page.locator('.cek-source-highlight').first().waitFor();
  await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
  await page.locator('.debug-state-bar[data-phase="terminated"]').waitFor();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.locator('.debugger-panel').evaluate((element) => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `Debugger overflow at ${width}: ${overflow}`);
    await page.screenshot({ path: path.join(output, `debugger-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1500, height: 1000 });

  // Compile two expressions in one module; every annotated file must match its
  // corresponding Flat output, even when output ordering differs from the source.
  const source = `{-# LANGUAGE TemplateHaskell, OverloadedStrings #-}
{-# LANGUAGE ImportQualifiedPost #-}
module Main where
import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx
import PlutusTx.Prelude qualified as P
choose :: Integer -> Integer
choose x = if x P.== 0 then P.trace "zero" 10 else P.trace "nonzero" (x P.+ 1)
chooseScript :: CompiledCode (Integer -> Integer)
chooseScript = $$(PlutusTx.compile [||choose||])
check :: Integer -> P.BuiltinUnit
check x = P.check (x P.== 0)
checkScript :: CompiledCode (Integer -> P.BuiltinUnit)
checkScript = $$(PlutusTx.compile [||check||])
main :: IO ()
main = pure ()`;
  const compiled = await request({ type: 'compile', project: ['PLINTH_PROJECT_V1', 'Main.hs', source].join('\0'), certify: true });
  assert.equal(compiled.programs.length, 2);
  const choose = compiled.programs.find((program) => program.uplc.includes('nonzero'));
  const check = compiled.programs.find((program) => !program.uplc.includes('nonzero'));
  assert.ok(choose?.debugAvailable && check?.debugAvailable);
  await checkMachine(choose.filename, ['integer:41'], /con integer 42/);
  await checkMachine(choose.filename, ['integer:0'], /con integer 10/);
  await checkMachine(check.filename, ['integer:0'], /con unit/);
  await checkMachine(check.filename, ['integer:1'], /terminated because of an error/);
  let state = await debug({ op: 'start', filename: choose.filename, args: ['integer:41'] });
  state = await debug({ op: 'step', count: 200, breakpoints: [{ file: 'Main.hs', line: 8 }] });
  assert.equal(state.done, false, 'Continue must stop at a source breakpoint');
  assert.equal(state.phase, 'computing');
  assert.ok(state.spans.some((span) => span.startLine === 8));
  await debug({ op: 'stop' });
  await assert.rejects(() => debug({ op: 'step', count: 1 }), /Start a debugger session first/);
  await assert.rejects(() => debug({ op: 'start', filename: choose.filename, args: ['integer:nope'] }), /Invalid integer/);

  // Real recursive source use-sites, not just a definition named fibonacci.
  await page.locator('.example-picker select').selectOption('fibonacci');
  await compile();
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  assert.equal(await page.getByLabel('Argument 1 value', { exact: true }).inputValue(), '5');
  await page.getByLabel('Argument 1 value', { exact: true }).fill('3');
  await page.getByRole('tab', { name: 'Debug', exact: true }).click();
  await page.getByRole('button', { name: 'Start debugger', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  const callColumns = new Set();
  let checkedFibonacciLayout = false;
  for (let i = 0; i < 120; i++) {
    const before = await page.locator('.debug-state-bar').getAttribute('data-step');
    await page.getByRole('button', { name: 'Next source', exact: true }).click();
    await page.waitForFunction((before) => document.querySelector('.debug-state-bar')?.getAttribute('data-step') !== before, before);
    const current = await page.evaluate(() => window.testLastDebugSnapshot);
    if (current.done) break;
    if (current.control?.label !== 'Var fibonacci [2]') continue;
    await page.waitForFunction(() => !document.querySelector('.debug-inspector .inspector-loading'));
    const highlights = await page.locator('.cek-source-highlight').evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, line: element.closest('.cm-line').textContent })));
    assert.ok(highlights.some(({ text, line }) => text === 'fibonacci' && line.includes('otherwise')), 'Highlight recursive use instead of the definition');
    assert.ok(highlights.some(({ text, line }) => text === 'fibonacci' && line.trim() === 'fibonacci n'), 'Also highlight the available definition span, not only the chosen call site');
    const focus = current.focusSpans.find((span) => span.file === 'Main.hs');
    assert.equal(focus.startLine, 16);
    callColumns.add(focus.startColumn);
    const bindings = await page.locator('.inspector-bindings > .inspector-node').allTextContents();
    assert.ok(bindings.some((text) => /n\[1\]integer[23]/.test(text)), 'Show named n and the current recursive argument');
    assert.ok(bindings.some((text) => text.includes('fibonacci')), 'Name the recursive function binding');
    assert.match(await page.locator('.inspector-frames').innerText(), /SubtractInteger/);
    assert.match(await page.locator('.inspector-frames').innerText(), /n =/);
    if (!checkedFibonacciLayout) {
      checkedFibonacciLayout = true;
      await page.locator('.debug-source-links > button').first().click();
      assert.ok((await page.locator('.cek-source-highlight').allTextContents()).filter(text => text === 'fibonacci').length >= 2, 'Navigating to another available span must not remove the other highlights');
      await page.screenshot({ path: path.join(output, 'fibonacci-call.png'), fullPage: true });
      for (const width of [1500, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await page.locator('.debugger-panel').evaluate(element => element.scrollWidth - element.clientWidth);
        assert.ok(overflow <= 1, `Fibonacci inspector overflow at ${width}px`);
        await page.screenshot({ path: path.join(output, `fibonacci-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1500, height: 1000 });
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.locator(`.debug-state-bar[data-step="${current.step - 1}"]`).waitFor();
      await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
      await page.locator(`.debug-state-bar[data-step="${current.step}"]`).waitFor();
      assert.deepEqual(machineState(await page.evaluate(() => window.testLastDebugSnapshot)), machineState(current));
    }
  }
  assert.deepEqual([...callColumns].sort((a, b) => a - b), [17, 51]);
  await page.locator('.debug-state-bar[data-phase="terminated"]').waitFor();
  assert.match(await page.locator('.debugger-panel').innerText(), /con integer 2/);
  console.log('Fibonacci example, both recursive call-site highlights, named arguments, readable saved frames and reverse stepping verified');

  // Check every CEK transition, not only Next source stops: even an unannotated
  // builtin must display all available continuation spans. Verify actual marks.
  await page.waitForFunction(() => document.querySelectorAll('.cm-content .cm-line').length === 19);
  const lines = await page.locator('.cm-content .cm-line').allTextContents();
  assert.equal(lines.length, 19, 'The short fixture must be fully visible for exact offset checks');
  const offset = (line, column) => lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  let contextOnly = 0;
  let multipleSpans = 0;
  for (let step = 1; step <= 300; step++) {
    await page.getByRole('button', { name: 'Step CEK', exact: true }).click();
    await page.locator(`.debug-state-bar[data-step="${step}"]`).waitFor();
    const current = await page.evaluate(() => window.testLastDebugSnapshot);
    const spans = [...current.spans, ...current.frames.flatMap(frame => frame.spans)].filter(span => span.file === 'Main.hs');
    const expected = spans.map(span => ({ from: offset(span.startLine, span.startColumn), to: offset(span.endLine, span.endColumn) }));
    await page.waitForFunction(expected => {
      const marks = [...document.querySelectorAll('.cek-source-highlight')].map(element => ({ from: Number(element.dataset.sourceFrom), to: Number(element.dataset.sourceTo) }));
      return expected.length ? expected.every(span => marks.some(mark => mark.from <= span.from && mark.to >= span.to)) : marks.length === 0;
    }, expected);
    if (!current.spans.some(span => span.file === 'Main.hs') && expected.length) {
      contextOnly++;
      if (contextOnly === 1) await page.screenshot({ path: path.join(output, 'continuation-source-spans.png'), fullPage: true });
    }
    if (new Set(expected.map(span => `${span.from}:${span.to}`)).size > 1) multipleSpans++;
    if (current.done) break;
  }
  assert.ok(contextOnly > 0 && multipleSpans > 0, 'Exercise both context-only states and simultaneous spans');
  await page.locator('.debug-state-bar[data-phase="terminated"]').waitFor();
  console.log('Every available state/frame span painted at every Fibonacci CEK step:', { contextOnly, multipleSpans });

  // A long-running program must remain pausable between bounded batches,
  // retain its state while paused, and reset completely on restart.
  await page.locator('.example-picker select').selectOption('equality');
  await replaceSource(`{-# LANGUAGE TemplateHaskell, ImportQualifiedPost #-}
module Main where
import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx
import PlutusTx.Prelude qualified as P
countdown :: Integer -> Integer
countdown n = if n P.== 0 then 0 else countdown (n P.- 1)
script :: CompiledCode (Integer -> Integer)
script = $$(PlutusTx.compile [||countdown||])
main :: IO ()
main = pure ()`);
  await compile();
  await page.getByRole('button', { name: 'Remove argument 2', exact: true }).click();
  await page.getByLabel('Argument 1 value', { exact: true }).fill('1000000');
  await page.getByRole('tab', { name: 'Debug', exact: true }).click();
  await page.getByRole('button', { name: 'Start debugger', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('.debug-state-bar')?.getAttribute('data-step')) >= 100);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
  const paused = await page.locator('.debug-state-bar').getAttribute('data-step');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.debug-state-bar').getAttribute('data-step'), paused);
  assert.notEqual(await page.locator('.debug-state-bar').getAttribute('data-phase'), 'terminated');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  await page.keyboard.press('F10');
  await page.locator('.debug-state-bar[data-step="1"]').waitFor();
  await page.keyboard.press('F11');
  await page.locator('.cek-source-highlight').first().waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Start debugger', exact: true }).waitFor();
  console.log('Pause, restart, source stepping, keyboard controls, and stop verified');

  // Retain every transition within a bounded history, including those inside
  // 200-step batches. Traversing it must leave the live frontier untouched.
  const longProgram = await page.evaluate(() => window.testLastCompilation.programs[0].filename);
  state = await debug({ op: 'start', filename: longProgram, args: ['integer:1000000'] });
  for (let i = 0; i < 55; i++) state = await debug({ op: 'step', count: 200 });
  assert.equal(state.step, 11000);
  assert.equal(state.history.first, state.step - state.history.limit);
  const frontier = state;
  for (let i = 0; i < 51; i++) state = await debug({ op: 'back', count: 200 });
  assert.equal(state.step, frontier.history.first, 'Back must clamp at the retained boundary');
  assert.equal(state.history.last, frontier.step, 'Rewinding must not discard the live frontier');
  for (let i = 0; i < 50; i++) state = await debug({ op: 'step', count: 200 });
  assert.deepEqual(machineState(state), machineState(frontier));
  state = await debug({ op: 'step', count: 1 });
  assert.equal(state.step, frontier.step + 1, 'Continue past history using the original live machine');
  state = await debug({ op: 'back', count: 1 });
  assert.deepEqual(machineState(state), machineState(frontier));
  await debug({ op: 'stop' });
  console.log('Bounded per-transition history, retained boundary, and live continuation verified');

  // Return to UI compilation after protocol checks; edits must clear the
  // current session and source highlighting rather than debug stale code.
  await page.locator('.example-picker select').selectOption('equality');
  await compile();
  await page.getByRole('tab', { name: 'Debug', exact: true }).click();
  await page.getByRole('button', { name: 'Start debugger', exact: true }).click();
  await page.locator('.debug-state-bar[data-step="0"]').waitFor();
  await replaceSource('module Main where\nmain = pure ()');
  assert.equal(await page.locator('.cek-source-highlight').count(), 0);
  assert.equal(await page.locator('.debug-state-bar').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Debugger checks passed. Screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error('Browser errors:', errors, 'Artifacts:', output);
  throw error;
} finally {
  await browser.close();
}
