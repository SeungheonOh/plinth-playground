const baseUrl = process.env.PLINTH_URL ?? 'http://localhost:56636/';
const target = await fetch(`http://127.0.0.1:9223/json/new?${encodeURIComponent(baseUrl)}`, {
  method: 'PUT',
}).then((response) => response.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeout = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

await command('Runtime.enable');
await command('Page.enable');
await waitFor(`document.readyState === 'complete'`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('runtime ready')`, 180_000);

await evaluate(`(() => {
  const workspace = document.querySelector('.source-workspace');
  if (workspace.dataset.treeOpen !== 'true') document.querySelector('.file-tree-toggle').click();
  return true;
})()`);
await waitFor(`document.querySelector('.source-workspace')?.dataset.treeOpen === 'true'`);
await evaluate(`document.querySelector('.file-tree-toggle').click()`);
await waitFor(`document.querySelector('.source-workspace')?.dataset.treeOpen === 'false' && document.querySelector('.project-tree').getBoundingClientRect().width < 1`);
await command('Page.reload');
await waitFor(`document.readyState === 'complete'`);
await waitFor(`document.querySelector('.source-workspace')?.dataset.treeOpen === 'false'`);
const collapsedTreeWidth = await evaluate(`document.querySelector('.project-tree').getBoundingClientRect().width`);
await evaluate(`document.querySelector('.file-tree-toggle').click()`);
await waitFor(`document.querySelector('.source-workspace')?.dataset.treeOpen === 'true' && document.querySelector('.project-tree').getBoundingClientRect().width > 100`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('runtime ready')`, 180_000);

await evaluate(`document.querySelector('.primary-button').click()`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('compiling')`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('runtime ready')`, 180_000);
await evaluate(`[...document.querySelectorAll('.result-tabs button')].find((button) => button.textContent.includes('UPLC')).click()`);
const singleUplc = await evaluate(`document.querySelector('.compiler-output')?.textContent ?? ''`);
if (!singleUplc.includes('addInteger') || !singleUplc.includes('integer 1')) {
  const debug = await evaluate(`({
    state: document.querySelector('.compiler-state')?.textContent,
    output: document.querySelector('.compiler-output')?.textContent,
    diagnostics: document.querySelector('.diagnostic-output')?.textContent,
  })`);
  throw new Error(`Unexpected single-module output: ${JSON.stringify(debug)}`);
}

await evaluate(`[...document.querySelectorAll('.topbar-actions button')].find((button) => button.textContent.includes('Run CEK')).click()`);
await waitFor(`document.querySelector('.machine-result pre')?.textContent.includes('integer 42')`, 60_000);
const plutarchResult = await evaluate(`document.querySelector('.machine-result pre')?.textContent ?? ''`);

await evaluate(`(() => {
  const select = document.querySelector('.example-picker select');
  select.value = 'modules';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelectorAll('.project-tree-file').length === 2`);

await evaluate(`document.querySelector('.primary-button').click()`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('compiling')`);
await waitFor(`document.querySelector('.compiler-state')?.textContent.includes('runtime ready')`, 180_000);
await evaluate(`[...document.querySelectorAll('.result-tabs button')].find((button) => button.textContent.includes('UPLC')).click()`);
const uplc = await evaluate(`document.querySelector('.compiler-output')?.textContent ?? ''`);
if (!uplc.includes('addInteger') || !uplc.includes('integer 2')) {
  const debug = await evaluate(`({
    state: document.querySelector('.compiler-state')?.textContent,
    activeTab: document.querySelector('.result-tabs [aria-selected="true"]')?.textContent,
    output: document.querySelector('.compiler-output')?.textContent,
    diagnostics: document.querySelector('.diagnostic-output')?.textContent,
  })`);
  throw new Error(`Unexpected multi-module output: ${JSON.stringify(debug)}`);
}

await evaluate(`document.querySelector('.share-button').click()`);
const hash = await waitFor(`location.hash.startsWith('#p=') && location.hash`);
const moduleNames = await evaluate(`[...document.querySelectorAll('.project-tree-file-select span')].map((node) => node.textContent)`);
if (moduleNames.join(',') !== 'Main.hs,LocalMath.hs') {
  throw new Error(`Unexpected module tabs: ${moduleNames.join(',')}`);
}

await command('Page.navigate', { url: `${baseUrl}${hash}` });
await waitFor(`document.readyState === 'complete'`);
await waitFor(`document.querySelectorAll('.project-tree-file').length === 2`);
const restored = await evaluate(`[...document.querySelectorAll('.project-tree-file-select span')].map((node) => node.textContent)`);

await evaluate(`document.querySelector('.project-tree-heading button').click()`);
await waitFor(`!!document.querySelector('.module-dialog')`);
await evaluate(`(() => {
  const input = document.querySelector('.module-dialog input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Validators.Math');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await evaluate(`document.querySelector('.module-dialog').requestSubmit()`);
await waitFor(`document.querySelectorAll('.project-tree-file').length === 3`);
const nestedTree = await evaluate(`({
  folders: [...document.querySelectorAll('.project-tree-folder span')].map((node) => node.textContent),
  files: [...document.querySelectorAll('.project-tree-file-select span')].map((node) => node.textContent),
  active: document.querySelector('.project-tree-file[data-active="true"] span')?.textContent,
})`);
if (nestedTree.folders.join(',') !== 'Validators' || nestedTree.active !== 'Math.hs') {
  throw new Error(`Unexpected nested project tree: ${JSON.stringify(nestedTree)}`);
}
await evaluate(`document.querySelector('.project-tree-folder').click()`);
await waitFor(`document.querySelectorAll('.project-tree-file').length === 2`);
await evaluate(`document.querySelector('.project-tree-folder').click()`);
await waitFor(`document.querySelectorAll('.project-tree-file').length === 3`);

console.log(JSON.stringify({ collapsedTreeWidth, singleUplc: singleUplc.slice(0, 120), plutarchResult, uplc: uplc.slice(0, 120), sharedHashLength: hash.length, restored, nestedTree }));
socket.close();
