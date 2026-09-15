import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { unzipSync, strFromU8 } from 'fflate';

const baseUrl = process.env.PLINTH_URL ?? 'http://127.0.0.1:5174/';
const output = await mkdtemp(path.join(tmpdir(), 'plinth-certificates-browser-'));
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

async function compile() {
  await page.locator('.primary-button').click();
  await page.waitForFunction(() => document.querySelector('.compiler-state')?.textContent.includes('compiling'));
  await page.waitForFunction(() => document.querySelector('.compiler-state')?.textContent.includes('runtime ready'), null, { timeout: 180_000 });
}

async function downloadZip(name) {
  const download = page.waitForEvent('download');
  await page.locator('.certificate-download').click();
  const downloaded = await download;
  assert.equal(downloaded.suggestedFilename(), 'plinth-optimization-certificates.zip');
  const filename = path.join(output, name);
  await downloaded.saveAs(filename);
  const zip = unzipSync(await readFile(filename));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  assert.equal(manifest.status, 'passed');
  assert.ok(Object.keys(zip).some((entry) => entry.endsWith('/plinth-certifier-PASS.txt')));
  assert.ok(Object.keys(zip).some((entry) => entry.endsWith('/src/main_Main.agda')));
  assert.ok(Object.keys(zip).some((entry) => entry.startsWith('programs/') && entry.endsWith('.uplc-flat')));
  return { zip, manifest };
}

try {
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('.compiler-state')?.textContent.includes('runtime ready'), null, { timeout: 240_000 });
  await page.locator('.example-picker select').selectOption('modules');
  await compile();
  assert.equal(await page.locator('.certification-result').getAttribute('data-status'), 'passed', await page.locator('.result-pane').innerText());
  const first = await downloadZip('multi-module.zip');
  assert.ok(first.zip['source/Main.hs']);
  assert.ok(first.zip['source/LocalMath.hs']);
  assert.match(strFromU8(first.zip['source/LocalMath.hs']), /addTwo/);
  console.log('Multi-module Plinth certificate downloaded:', first.manifest.projects);

  // Exercise the actual optimized output on the CEK machine.
  await page.locator('.run-button').click();
  await page.waitForFunction(() => document.querySelector('.machine-result pre')?.textContent.includes('integer 42'), null, { timeout: 60_000 });

  // Multiple compile splices must each retain their own certificate project.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(`{-# LANGUAGE TemplateHaskell #-}
{-# LANGUAGE ImportQualifiedPost #-}
module Main where
import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx
import PlutusTx.Prelude qualified as Plinth

addOne :: Integer -> Integer
addOne x = x Plinth.+ 1
successor :: CompiledCode (Integer -> Integer)
successor = $$(PlutusTx.compile [|| addOne ||])

checkEqual :: Integer -> Integer -> Plinth.BuiltinUnit
checkEqual x y = Plinth.check (x Plinth.== y)
validator :: CompiledCode (Integer -> Integer -> Plinth.BuiltinUnit)
validator = $$(PlutusTx.compile [|| checkEqual ||])

main :: IO ()
main = pure ()
`);
  await compile();
  const multiple = await downloadZip('multiple-programs.zip');
  assert.equal(multiple.manifest.projects.length, 2);
  assert.equal(Object.keys(multiple.zip).filter((entry) => entry.startsWith('programs/') && entry.endsWith('.uplc-flat')).length, 2);
  assert.ok(Object.entries(multiple.zip).some(([entry, bytes]) => entry.endsWith('/Proof.agda') && strFromU8(bytes).includes('related :')),
    'Expected a nontrivial optimization trace with a per-pass proof');
  console.log('Multiple compiled expressions and nontrivial proof trace:', multiple.manifest.projects);

  // Compiling again replaces certificates instead of collecting prior builds.
  await page.locator('.example-picker select').selectOption('equality');
  await compile();
  const second = await downloadZip('equality.zip');
  assert.equal(second.manifest.projects.length, 1);
  assert.equal(second.zip['source/LocalMath.hs'], undefined);
  assert.notEqual(second.manifest.projects[0].directory, first.manifest.projects[0].directory);

  // Check alignment and overflow in a narrow result pane and on mobile.
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const bounds = await page.locator('.certification-result').evaluate((element) => ({
      width: element.clientWidth, scroll: element.scrollWidth,
      button: element.querySelector('button').getBoundingClientRect().toJSON(),
      panel: element.getBoundingClientRect().toJSON(),
    }));
    assert.ok(bounds.scroll <= bounds.width + 1, `Certificate panel overflow at ${width}`);
    assert.ok(bounds.button.right <= bounds.panel.right + 1, `Download button overflow at ${width}`);
    await page.screenshot({ path: path.join(output, `certificate-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Certify optimizations', { exact: true }).uncheck();
  await compile();
  assert.equal(await page.locator('.certification-result').getAttribute('data-status'), 'disabled');
  assert.equal(await page.locator('.certificate-download').count(), 0);

  await page.getByLabel('Certify optimizations', { exact: true }).check();
  await page.locator('.example-picker select').selectOption('plutarch-successor');
  await compile();
  assert.equal(await page.locator('.certification-result').getAttribute('data-status'), 'unavailable');
  assert.equal(await page.locator('.certificate-download').count(), 0);

  // A failed build must not leave an earlier certificate downloadable.
  await page.locator('.example-picker select').selectOption('equality');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('this is not valid Haskell\n');
  await compile();
  assert.equal(await page.locator('.certificate-download').count(), 0);
  assert.equal(await page.locator('.certification-result').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Certificate browser checks passed. Downloads/screenshots: ${output}`);
} finally {
  await browser.close();
}
