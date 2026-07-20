import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const source = join('src', 'workflows', 'builtins');
const destination = join('dist', 'workflows', 'builtins');

mkdirSync(destination, { recursive: true });
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.yaml')) {
    cpSync(join(source, entry.name), join(destination, entry.name));
  }
}
