import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const root = resolve('.');

if (!dist.startsWith(`${root}/`)) {
  throw new Error('Refusing to clean a path outside this repository');
}

if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
}
