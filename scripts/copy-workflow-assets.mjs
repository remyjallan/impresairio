import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function copyAssets(source, destination, extension) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) {
      cpSync(join(source, entry.name), join(destination, entry.name));
    }
  }
}

copyAssets(join('src', 'workflows', 'builtins'), join('dist', 'workflows', 'builtins'), '.yaml');
copyAssets(join('src', 'prompts', 'builtins'), join('dist', 'prompts', 'builtins'), '.md');
