import { strToU8, zipSync } from 'fflate';

export type CertificateProject = {
  directory: string;
  status: 'passed' | 'partial' | 'failed' | 'incomplete';
  fileCount: number;
  message?: string;
};

export type OptimizationCertification = {
  status: 'passed' | 'partial' | 'failed' | 'unavailable' | 'disabled';
  projects: CertificateProject[];
  message: string;
  archive?: { filename: string; bytes: Uint8Array<ArrayBuffer> };
};

type CertificateInputs = {
  files: Record<string, Uint8Array>;
  sources: Record<string, Uint8Array>;
  programs: Array<{ filename: string; flatHex: string; uplc: string }>;
  flags: string;
  runtimeVersion: string;
};

function safePath(path: string) {
  if (!path || path.includes('\\') || path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid certificate archive path: ${path}`);
  }
  return path;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Package the plugin's actual files. A successful Haskell build alone is not certification. */
export async function packageOptimizationCertificates({
  files, sources, programs, flags, runtimeVersion,
}: CertificateInputs): Promise<OptimizationCertification> {
  const decoder = new TextDecoder();
  const directories = [...new Set(Object.keys(files)
    .map((path) => safePath(path).split('/')[0])
    .filter((name) => name.endsWith('.agda-cert')))].sort();
  if (directories.length === 0) {
    return {
      status: 'unavailable', projects: [],
      message: 'No Plinth certificate was emitted. Plutarch exports do not use the Plinth certifier.',
    };
  }

  const projects: CertificateProject[] = directories.map((directory) => {
    const paths = Object.keys(files).filter((path) => path.startsWith(`${directory}/`));
    const failure = files[`${directory}/plinth-certifier-FAIL.txt`];
    const main = paths.find((path) =>
      path.startsWith(`${directory}/src/`) && path.split('/').length === 3 && path.endsWith('.agda'));
    const mainSource = main ? decoder.decode(files[main]) : '';
    const complete = mainSource.includes('certificate : Certificate trace') &&
      paths.some((path) => path.endsWith('.agda-lib'));
    const passed = files[`${directory}/plinth-certifier-PASS.txt`] !== undefined;
    // Upstream accepts passes without a relation through NotImplemented.
    // Detect them in the generated top-level trace, even if a module overrode
    // the requested certified-opts-only flag and the plugin wrote PASS.
    const partial = /inj₁\s+(?:caseOfCaseT|constantFoldingT|polyBuiltinT)\b/.test(mainSource);
    const status = failure !== undefined ? 'failed'
      : !passed || !complete ? 'incomplete' : partial ? 'partial' : 'passed';
    return {
      directory, status, fileCount: paths.length,
      ...(failure !== undefined ? { message: decoder.decode(failure).trim() } : {}),
    };
  });

  const status = projects.some((project) => project.status === 'failed') ? 'failed'
    : projects.some((project) => project.status === 'incomplete') ? 'unavailable'
      : projects.some((project) => project.status === 'partial') ? 'partial' : 'passed';
  const message = status === 'passed'
    ? `${projects.length} optimization certificate${projects.length === 1 ? '' : 's'} generated; Plinth certifier passed.`
    : status === 'partial' ? 'The trace includes optimization passes without certification support.'
      : status === 'failed' ? 'The Plinth certifier rejected an optimization trace. Download includes its failure report.'
        : 'Certificate generation was incomplete. Download includes the files that were emitted.';
  const archive: Record<string, Uint8Array> = Object.create(null);
  const hashes: Record<string, string> = Object.create(null);
  const addFile = async (path: string, bytes: Uint8Array) => {
    archive[safePath(path)] = bytes;
    hashes[path] = await sha256(bytes);
  };

  for (const [path, bytes] of Object.entries(files)) {
    await addFile(`certificates/${safePath(path)}`, bytes);
  }
  for (const [path, bytes] of Object.entries(sources)) {
    await addFile(`source/${safePath(path)}`, bytes);
  }
  for (const program of programs) {
    const filename = safePath(program.filename.replace(/^\.\//, ''));
    if (!/^(?:[0-9a-f]{2})+$/i.test(program.flatHex)) throw new Error('Invalid Flat program');
    const flat = Uint8Array.from(program.flatHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    await addFile(`programs/${filename}`, flat);
    await addFile(`programs/${filename}.uplc`, strToU8(program.uplc));
  }
  archive['manifest.json'] = strToU8(JSON.stringify({
    format: 'plinth-optimization-certificates-v1',
    generatedAt: new Date().toISOString(),
    compiler: { plinth: '1.66.0.0', runtimeVersion, flags },
    scope: 'UPLC optimization trace only; excludes Haskell-to-PIR/PLC translation and Main.main exports.',
    verification: 'Plinth embedded certifier; independent Agda type checking has not been run by this app.',
    status, projects, sha256: hashes,
  }, null, 2));
  archive['README.md'] = strToU8(`# Plinth optimization certificates

${message}

Each certificates/*.agda-cert/ directory is the original project emitted by
Plinth's certify option. It includes the optimizer's intermediate terms, per-pass
proofs, an Agda library file, verification instructions, and its PASS/FAIL marker.
The source/ and programs/ directories contain this build's Haskell files and
compiled output. manifest.json records compiler flags, runtime version, status,
and SHA-256 hashes. This is a bundle for one compilation; file order does not
establish a one-to-one mapping between programs and certificate directories.
Plutarch scripts exported by Main.main are included as outputs but are not certified.

## What is checked

The browser requested certify and certified-opts-only. The latter disables UPLC
passes that lack a certifier, which can change script size and execution cost.
Source-level plugin options may override these flags; partial coverage is marked
separately when the generated trace includes unsupported passes.
The certificate covers UPLC optimization relations. It does not prove the entire
Haskell-to-UPLC translation, contract correctness, or execution-cost equivalence.
PASS means the plugin's embedded Agda-derived certifier accepted the trace.
The browser does not independently type-check the exported Agda project.

## Independent verification

Use Agda 2.8.0, standard-library 2.3, and plutus-metatheory from the compiler's
pinned Plutus revision: 2e582ecde824238f927322d208740322eada8115.
Follow the README.md inside each certificate directory to register the libraries
and type-check its top-level src/*.agda module. This bundle does not include those
external libraries. FAIL, partial, and incomplete projects must not be treated
as fully certified optimization traces.
`);

  return {
    status, projects, message,
    archive: {
      filename: 'plinth-optimization-certificates.zip',
      bytes: zipSync(archive, { level: 6 }),
    },
  };
}
