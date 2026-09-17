import type { CekArgument } from './compiler-runtime';

export function encodeCekArgument(argument: CekArgument) {
  const utf8Hex = (value: string) => [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  switch (argument.kind) {
    case 'unit': return 'unit';
    case 'integer': return `integer:${argument.value.trim()}`;
    case 'bool': return `bool:${argument.value.trim().toLowerCase()}`;
    case 'bytes': return `bytes:${argument.value.trim().replace(/^0x/i, '').replace(/\s/g, '')}`;
    case 'string': return `string:${utf8Hex(argument.value)}`;
    case 'data': return `data:${utf8Hex(argument.value)}`;
  }
}
