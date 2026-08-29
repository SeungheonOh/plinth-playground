import type { CekArgument, SourceModule } from './compiler-runtime';

type SharedProject = {
  v: 1;
  modules: SourceModule[];
  active: string;
  arguments: CekArgument[];
};

const MAX_SHARED_MODULES = 32;
const MAX_SHARED_SOURCE_LENGTH = 1_000_000;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function compress(bytes: Uint8Array) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([asArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot open compressed project links');
  }
  const stream = new Blob([asArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isSourceModule(value: unknown): value is SourceModule {
  if (!value || typeof value !== 'object') return false;
  const sourceModule = value as Partial<SourceModule>;
  return typeof sourceModule.name === 'string'
    && typeof sourceModule.source === 'string'
    && /^[A-Z][A-Za-z0-9_]*(?:\/[A-Z][A-Za-z0-9_]*)*\.hs$/.test(sourceModule.name);
}

function isCekArgument(value: unknown): value is CekArgument {
  if (!value || typeof value !== 'object') return false;
  const argument = value as Partial<CekArgument>;
  return typeof argument.value === 'string'
    && ['integer', 'bytes', 'string', 'bool', 'unit', 'data'].includes(argument.kind ?? '');
}

function parseSharedProject(value: unknown): SharedProject {
  if (!value || typeof value !== 'object') throw new Error('Invalid shared project');
  const project = value as Partial<SharedProject>;
  if (project.v !== 1 || !Array.isArray(project.modules) || !Array.isArray(project.arguments)) {
    throw new Error('Unsupported shared project format');
  }
  if (project.modules.length === 0 || project.modules.length > MAX_SHARED_MODULES) {
    throw new Error('Shared project has an invalid module count');
  }
  if (!project.modules.every(isSourceModule) || !project.arguments.every(isCekArgument)) {
    throw new Error('Shared project contains invalid source data');
  }
  const names = project.modules.map((sourceModule) => sourceModule.name);
  const totalSourceLength = project.modules.reduce((total, sourceModule) => total + sourceModule.source.length, 0);
  if (
    !names.includes('Main.hs')
    || new Set(names).size !== names.length
    || totalSourceLength > MAX_SHARED_SOURCE_LENGTH
  ) {
    throw new Error('Shared project contains an invalid module tree');
  }
  const active = typeof project.active === 'string' && names.includes(project.active)
    ? project.active
    : 'Main.hs';
  return {
    v: 1,
    modules: project.modules,
    active,
    arguments: project.arguments,
  };
}

export async function encodeSharedProject(
  modules: SourceModule[],
  active: string,
  arguments_: CekArgument[],
) {
  const project: SharedProject = {
    v: 1,
    modules,
    active,
    arguments: arguments_,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(project));
  const compressed = await compress(encoded);
  return compressed && compressed.length < encoded.length
    ? `z${bytesToBase64Url(compressed)}`
    : `j${bytesToBase64Url(encoded)}`;
}

export async function decodeSharedProject(payload: string) {
  if (payload.length < 2) throw new Error('The project link is empty');
  const format = payload[0];
  const bytes = base64UrlToBytes(payload.slice(1));
  const decoded = format === 'z'
    ? await decompress(bytes)
    : format === 'j'
      ? bytes
      : (() => { throw new Error('Unsupported project link'); })();
  return parseSharedProject(JSON.parse(new TextDecoder().decode(decoded)) as unknown);
}
