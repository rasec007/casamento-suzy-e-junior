import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const storageModule = new URL('../server/storage.js', import.meta.url).href;
const key = 'weddings/11111111-1111-4111-8111-111111111111/mirror/22222222-2222-4222-8222-222222222222.png';
const run = (directory, program, production = false) => spawnSync(process.execPath, ['--input-type=module', '-e', `import * as storage from ${JSON.stringify(storageModule)}; ${program}`], { env: { ...process.env, STORAGE_DIR: directory, NODE_ENV: production ? 'production' : 'test' }, encoding: 'utf8' });

test('uploads persist across processes, and invalid paths and missing images are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wedding-storage-'));
  try {
    const create = run(root, `await storage.ensureStorage(); await storage.putImage(${JSON.stringify(key)}, Buffer.from('test image')); try { await storage.putImage('../escape.png', Buffer.from('bad')); process.exit(2); } catch {} `);
    assert.equal(create.status, 0, create.stderr);
    assert.equal(await readFile(join(root, key), 'utf8'), 'test image');
    const read = run(root, `const img=await storage.getImage(${JSON.stringify(key)}); let chunks=''; for await(const chunk of img.Body) chunks+=chunk; if(chunks!=='test image'||img.ContentType!=='image/png') process.exit(2); await storage.deleteImage(${JSON.stringify(key)}); try { await storage.getImage(${JSON.stringify(key)}); process.exit(3); } catch(error) { if(error.name!=='NoSuchKey') throw error; }`);
    assert.equal(read.status, 0, read.stderr);
    const prod = run(root, 'await storage.ensureStorage()', true);
    assert.notEqual(prod.status, 0);
    assert.match(prod.stderr, /volume montado/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects symlinked upload directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wedding-storage-'));
  const outside = await mkdtemp(join(tmpdir(), 'wedding-outside-'));
  try {
    await symlink(outside, join(root, 'weddings'));
    const result = run(root, `await storage.ensureStorage(); await storage.putImage(${JSON.stringify(key)}, Buffer.from('bad'));`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Diretório de imagens inválido/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
