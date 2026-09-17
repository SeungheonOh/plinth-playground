#!/usr/bin/env -S node --max-old-space-size=65536 --wasm-lazy-validation

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import assert from 'node:assert/strict';

const workdir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = process.env.BROWSER_SOURCE ?? "BrowserPlinth.hs";
const bundledProjectFile = process.env.BROWSER_PROJECT_PAYLOAD;
const projectLinksFile = process.env.BROWSER_PROJECT_LINKS;
const extraSourceFiles = process.env.BROWSER_EXTRA_SOURCES
  ?.split(",")
  .map((source) => source.trim())
  .filter(Boolean) ?? [];
const extraArgs = process.env.BROWSER_EXTRA_ARGS?.trim().split(/\s+/).filter(Boolean) ?? [];
const toolchain =
  process.env.GHC_WASM_PREFIX ?? path.join(workdir, ".compiler-deps", "ghc-wasm");
const ghcVersion = process.env.GHC_WASM_VERSION ?? "9.12.4.20260731";
const { DyLDHost, main: startDynamicLinker } = await import(
  `${toolchain}/wasm32-wasi-ghc/lib/dyld.mjs`
);

class PlinthDyLDHost extends DyLDHost {
  async findSystemLibrary(filename) {
    // GHC's interpreter adds a second lib prefix to this WASI SDK shim.
    const corrected = {
      "liblibwasi-emulated-mman.so": "libuplc-ghc-empty.so",
      // libdl is absent on WASI and no loaded code needs its symbols.
      "liblibdl.so": "libuplc-ghc-empty.so",
    }[filename] ?? filename;
    return super.findSystemLibrary(corrected);
  }
}

const libdir = `${toolchain}/wasm32-wasi-ghc/lib`;
const store = `${toolchain}/.cabal/store/ghc-${ghcVersion}-inplace`;
const build = `${workdir}/dist-uplc-ghc-wasm-9.12`;
const projectPackageDb = `${build}/packagedb/ghc-${ghcVersion}`;
const storePackageDb = `${store}/package.db`;

async function sharedLibraryDirectories(root) {
  const directories = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(item);
      } else if (entry.name.endsWith(".so")) {
        directories.add(directory);
      }
    }
  }
  return directories;
}

const searchDirectories = new Set([
  workdir,
  `${toolchain}/wasi-sdk/share/wasi-sysroot/lib/wasm32-wasi`,
]);
for (const root of [libdir, store, build]) {
  for (const directory of await sharedLibraryDirectories(root)) {
    searchDirectories.add(directory);
  }
}

const linker = await startDynamicLinker({
  rpc: new PlinthDyLDHost({}),
  searchDirs: [...searchDirectories],
  mainSoPath: `${workdir}/libuplc-ghc-browser.so`,
  args: ["libuplc-ghc-browser.so", "+RTS", "-K512m", "-RTS"],
  isIserv: false,
});

const compile = await linker.exportFuncs.uplcGhcBrowser(
  libdir,
  `${storePackageDb}:${projectPackageDb}:`,
);
function decodeProjectPayload(payload) {
  if (payload[0] !== "z") {
    throw new Error("Project payload is not gzip-compressed");
  }
  const encoded = payload.slice(1).replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
}

let projects;
if (projectLinksFile) {
  const markdown = await fs.readFile(path.resolve(workdir, projectLinksFile), "utf8");
  const payloads = [
    ...markdown.matchAll(/https:\/\/plinth\.isotopy\.xyz\/#p=(z[A-Za-z0-9_-]+)/g),
  ].map((match) => match[1]);
  if (payloads.length === 0) throw new Error("Markdown file contains no project links");
  projects = payloads.map((payload) => {
    const decoded = decodeProjectPayload(payload);
    return decoded.modules.map(({ name, source }) => [name, source]);
  });
} else if (bundledProjectFile) {
  const payloadModule = await fs.readFile(path.join(workdir, bundledProjectFile), "utf8");
  const chunks = [...payloadModule.matchAll(/^\s*'([^']*)',\s*$/gm)]
    .map((match) => match[1]);
  if (chunks.length === 0) throw new Error("Bundled example contains no project payload");
  const decoded = decodeProjectPayload(chunks.join(""));
  projects = [decoded.modules.map(({ name, source }) => [name, source])];
} else {
  const modules = [
    ["Main.hs", await fs.readFile(path.join(workdir, sourceFile), "utf8")],
  ];
  for (const extraSourceSpec of extraSourceFiles) {
    const separator = extraSourceSpec.indexOf("=");
    const filename = separator === -1
      ? extraSourceSpec
      : extraSourceSpec.slice(0, separator);
    const sourceFilePath = separator === -1
      ? extraSourceSpec
      : extraSourceSpec.slice(separator + 1);
    modules.push([
      filename,
      await fs.readFile(path.join(workdir, sourceFilePath), "utf8"),
    ]);
  }
  projects = [modules];
}

for (const [projectIndex, modules] of projects.entries()) {
  const project = [
    "PLINTH_PROJECT_V1",
    ...modules.flatMap(([filename, source]) => [filename, source]),
  ].join("\0");
  const compiledOutputs = await compile(
    [
      "-package=plutus-tx",
      ...extraArgs,
      "-fplugin-opt=Plinth.Plugin:dump-uplc",
      "-fplugin-opt=Plinth.Plugin:preserve-source-locations",
      "-Wno-missed-extra-shared-lib",
      "-v1",
      "-fno-full-laziness",
      "-fno-ignore-interface-pragmas",
      "-fno-omit-interface-pragmas",
      "-fno-spec-constr",
      "-fno-specialise",
      "-fno-strictness",
      "-fno-unbox-small-strict-fields",
      "-fno-unbox-strict-fields",
      "-fprefer-byte-code",
      "-fno-unoptimized-core-for-interpreter",
      "-fno-write-interface",
      "-fforce-recomp",
    ].join(" "),
    project,
  );

  const outputs = compiledOutputs.trim().split("\n").filter(Boolean);
  const expectedOneOutput = projects.length === 1 && !projectLinksFile;
  if (outputs.length === 0 || (expectedOneOutput && outputs.length !== 1)) {
    throw new Error(
      `Expected ${expectedOneOutput ? "one" : "at least one"} compiled UPLC program, got ${outputs.length}`,
    );
  }
  for (const output of outputs) {
    const [filename, hex] = output.split("\t");
    if (!filename || !hex || hex.length % 2 !== 0) {
      throw new Error(`Invalid compiler output record: ${output}`);
    }
    const bytes = Buffer.from(hex, "hex");
    if (process.env.BROWSER_DEBUG_TEST === '1') {
      const debug = await linker.exportFuncs.uplcCekDebugger();
      const send = async (command) => {
        const result = JSON.parse(await debug(JSON.stringify(command)));
        if (result.error) throw new Error(result.error);
        return result;
      };
      const debugArgs = JSON.parse(process.env.BROWSER_DEBUG_ARGS ?? '["integer:41"]');
      const debugLimit = Number(process.env.BROWSER_DEBUG_LIMIT ?? 200);
      let snapshot = await send({ op: 'start', filename, args: debugArgs });
      const recorded = [snapshot];
      const observedSpans = [];
      const operatorStates = [];
      const namedBindings = [];
      const callSiteTest = process.env.BROWSER_CALL_SITE_TEST === '1';
      const mapping = process.env.BROWSER_OPERATOR_TEST === '1' || callSiteTest ? await import('../app/cek-debugger.ts') : null;
      const trace = [];
      const inspect = async (reference) => reference ? await send({ op: 'inspect', epoch: snapshot.epoch, ref: reference.ref }) : null;
      const recordTrace = async () => {
        if (!process.env.BROWSER_DEBUG_TRACE) return;
        trace.push({ snapshot, control: await inspect(snapshot.control), environment: await inspect(snapshot.environment),
          frames: await Promise.all(snapshot.frames.map(async (frame) => ({ ...frame,
            fields: await Promise.all(frame.fields.map(async (field) => ({ ...field, object: await inspect(field) }))),
          }))) });
      };
      await recordTrace();
      if (snapshot.step !== 0) throw new Error('Debugger did not start at step 0');
      for (let i = 0; i < debugLimit && !snapshot.done; i++) {
        const next = await send({ op: 'step', count: 1 });
        if (next.step !== snapshot.step + 1) throw new Error('Skipped CEK transition');
        snapshot = next;
        recorded.push(snapshot);
        observedSpans.push(...snapshot.spans);
        if (mapping) {
          const location = mapping.focusedProjectSpans(snapshot, modules.map(([name, source]) => ({ name, source })))[0];
          const source = modules.find(([name]) => name === location?.file)?.[1];
          const range = source && location ? mapping.spanOffsets(source, location) : null;
          operatorStates.push({ step: snapshot.step, phase: snapshot.phase, control: snapshot.control?.label,
            highlighted: range ? source.slice(range.from, range.to) : null, range, spans: snapshot.spans });
        }
        if (snapshot.environment) {
          const environment = await send({ op: 'inspect', epoch: snapshot.epoch, ref: snapshot.environment.ref });
          if (callSiteTest) namedBindings.push(...environment.children);
        }
        await recordTrace();
      }
      if (!snapshot.done || snapshot.failure) throw new Error('Debugger did not terminate successfully');
      console.log('DEBUG RESULT', JSON.stringify({ steps: snapshot.step, result: snapshot.result, budget: snapshot.budget, spans: [...new Map(observedSpans.map((span) => [JSON.stringify(span), span])).values()] }));
      if (process.env.BROWSER_DEBUG_TRACE) await fs.writeFile(process.env.BROWSER_DEBUG_TRACE, JSON.stringify({ source: modules, states: trace, highlights: operatorStates }, null, 2));
      if (sourceFile === 'BrowserPlinth.hs' && !observedSpans.some((span) => span.file === 'Main.hs' && span.startLine === 11 && span.startColumn === 12 && span.endColumn === 13)) {
        throw new Error('Missing granular span for x at Main.hs:11:12–11:13');
      }
      if (process.env.BROWSER_OPERATOR_TEST === '1' && !operatorStates.some((state) => state.highlighted === 'Plinth.+')) {
        console.log('OPERATOR STATES', JSON.stringify(operatorStates));
        throw new Error('No CEK step highlights the qualified operator Plinth.+');
      }
      if (callSiteTest) {
        const source = modules.find(([name]) => name === 'Main.hs')[1];
        const calls = [...source.matchAll(/fibonacci (?=\()/g)].map((match) => match.index);
        assert.equal(calls.length, 2, 'Fixture must contain both recursive Fibonacci call sites');
        const covered = calls.map((start) => operatorStates.some(({ range }) => range && range.from <= start && range.to >= start + 'fibonacci'.length));
        console.log('CALL SITE COVERAGE', JSON.stringify({ covered, highlights: [...new Set(operatorStates.map(({ highlighted }) => highlighted))] }));
        assert.deepEqual(covered, [true, true], 'Both recursive Fibonacci calls must receive a source highlight');
        assert.ok(namedBindings.some((binding) => binding.name === 'n' && binding.index === 1 && binding.label.includes('(con integer 3)')), 'Show the real named n = 3 binding');
        assert.ok(namedBindings.some((binding) => binding.name === 'n' && binding.index === 1 && binding.label.includes('(con integer 2)')), 'Update the binding on recursive entry');
        assert.ok(namedBindings.some((binding) => binding.name === 'fibonacci' && binding.label.includes('Lambda closure')), 'Retain the recursive closure binding name');
      }
      if (process.env.BROWSER_REVERSE_TEST === '1') {
        const comparable = ({ epoch, history, ...value }) => value;
        for (let i = recorded.length - 2; i >= 0; i--) {
          const back = await send({ op: 'back', count: 1 });
          assert.deepEqual(comparable(back), comparable(recorded[i]), `Backward state ${i} differs`);
          if (back.environment) await send({ op: 'inspect', epoch: back.epoch, ref: back.environment.ref });
        }
        for (let i = 1; i < recorded.length; i++) {
          const forward = await send({ op: 'step', count: 1 });
          assert.deepEqual(comparable(forward), comparable(recorded[i]), `Forward history state ${i} differs`);
        }
        console.log('Exact backward/forward CEK history verified');
      }
      if (callSiteTest) {
        let current = await send({ op: 'start', filename, args: debugArgs });
        const reached = new Set();
        for (let i = 0; i < debugLimit && !current.done; i++) {
          current = await send({ op: 'step', count: 200, source: true });
          const location = mapping.focusedProjectSpans(current, modules.map(([name, source]) => ({ name, source })))[0];
          if (location?.startLine === 15 && [17, 51].includes(location.startColumn)) reached.add(location.startColumn);
        }
        assert.deepEqual([...reached].sort((a, b) => a - b), [17, 51], 'Next source must stop at both recursive call sites');
        console.log('Named recursive bindings and Next source call sites verified');
      }
    }
    if (bytes.length === 0) {
      throw new Error(`Compiler emitted an empty UPLC program: ${filename}`);
    }
    const outputPath = path.join(workdir, "BrowserPlinth.uplc-flat");
    await fs.writeFile(outputPath, bytes);
    await fs.rm(path.join(workdir, filename), { force: true });
    console.log(
      `Project ${projectIndex + 1}/${projects.length}: ${filename} (${bytes.length} bytes)`,
    );
  }
}
