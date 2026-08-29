import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

const [
  archiveArgument,
  outputArgument,
  partSizeArgument = '20971520',
  ghcPrefix,
  ghcVersion,
  projectPackageDb,
] = process.argv.slice(2);
if (!archiveArgument || !outputArgument) {
  throw new Error(
    'usage: split-rootfs.mjs ARCHIVE OUTPUT_DIRECTORY [PART_SIZE GHC_PREFIX GHC_VERSION PROJECT_PACKAGE_DB]',
  );
}
if ([ghcPrefix, ghcVersion, projectPackageDb].some(Boolean)
    && ![ghcPrefix, ghcVersion, projectPackageDb].every(Boolean)) {
  throw new Error('compiler metadata requires GHC_PREFIX, GHC_VERSION, and PROJECT_PACKAGE_DB');
}

const archivePath = resolve(archiveArgument);
const outputDirectory = resolve(outputArgument);
const partSize = Number(partSizeArgument);
if (!Number.isSafeInteger(partSize) || partSize < 1_048_576) {
  throw new Error('part size must be an integer of at least 1 MiB');
}

for (const entry of await readdir(outputDirectory)) {
  if (/^rootfs\.part-\d{3}$/.test(entry)) await unlink(join(outputDirectory, entry));
}

const archive = await readFile(archivePath);
const parts = [];
for (let offset = 0, index = 0; offset < archive.byteLength; offset += partSize, index += 1) {
  const file = `rootfs.part-${String(index).padStart(3, '0')}`;
  const chunk = archive.subarray(offset, Math.min(offset + partSize, archive.byteLength));
  await writeFile(join(outputDirectory, file), chunk);
  parts.push({ file, size: chunk.byteLength });
}

const manifest = {
  format: basename(archivePath),
  version: createHash('sha256').update(archive).digest('hex').slice(0, 16),
  totalSize: archive.byteLength,
  parts,
  ...(ghcPrefix && ghcVersion && projectPackageDb
    ? {
        compiler: {
          ghcPrefix,
          ghcVersion,
          projectPackageDb,
        },
      }
    : {}),
};
await writeFile(
  join(outputDirectory, 'rootfs-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await unlink(archivePath);
