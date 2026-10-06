import { readdir } from 'node:fs/promises';

const files = (await readdir(new URL('.', import.meta.url)))
  .filter(file => file.endsWith('.test.js'))
  .sort();

for (const file of files) await import(new URL(file, import.meta.url));
