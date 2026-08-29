#!/usr/bin/env -S node --max-old-space-size=65536 --wasm-lazy-validation

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const workdir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = process.env.BROWSER_SOURCE ?? "BrowserPlinth.hs";
const bundledProjectFile = process.env.BROWSER_PROJECT_PAYLOAD;
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
let modules;
if (bundledProjectFile) {
  const payloadModule = await fs.readFile(path.join(workdir, bundledProjectFile), "utf8");
  const chunks = [...payloadModule.matchAll(/^\s*'([^']*)',\s*$/gm)]
    .map((match) => match[1]);
  if (chunks.length === 0) throw new Error("Bundled example contains no project payload");
  const payload = chunks.join("");
  if (payload[0] !== "z") throw new Error("Bundled example is not gzip-compressed");
  const encoded = payload.slice(1).replace(/-/g, "+").replace(/_/g, "/");
  const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
  modules = decoded.modules.map(({ name, source }) => [name, source]);
} else {
  modules = [
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
}
const project = [
  "PLINTH_PROJECT_V1",
  ...modules.flatMap(([filename, source]) => [filename, source]),
].join("\0");
const compiledOutputs = await compile(
  [
    "-package=plutus-tx",
    ...extraArgs,
    "-fplugin-opt=Plinth.Plugin:dump-uplc",
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

const outputs = compiledOutputs.trim().split("\n");
if (outputs.length !== 1) {
  throw new Error(`Expected one compiled UPLC program, got ${outputs.length}`);
}
for (const output of outputs) {
  const [filename, hex] = output.split("\t");
  if (!filename || !hex || hex.length % 2 !== 0) {
    throw new Error(`Invalid compiler output record: ${output}`);
  }
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0) {
    throw new Error(`Compiler emitted an empty UPLC program: ${filename}`);
  }
  const outputPath = path.join(workdir, "BrowserPlinth.uplc-flat");
  await fs.writeFile(outputPath, bytes);
  await fs.rm(path.join(workdir, filename), { force: true });
  console.log(`Flat UPLC: ${outputPath} (${bytes.length} bytes)`);
}
