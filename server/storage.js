import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const keyPattern = /^(?:venues\/(?:ceremony|reception)|gifts)\/[a-f0-9-]{36}\.(?:jpg|png|webp)$|^weddings\/[a-f0-9-]{36}\/(?:(?:venues\/(?:ceremony|reception)\/)|(?:gifts|hero|mirror)\/)[a-f0-9-]{36}\.(?:jpg|png|webp)$/;
const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const directory = resolve(process.env.STORAGE_DIR || '.local-runtime/uploads');

function targetPath(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new Error('Chave de imagem inválida.');
  return join(directory, key);
}

async function checkDirectories(path, create = false) {
  const parts = path.slice(directory.length).split('/').filter(Boolean);
  let current = directory;
  for (const part of parts) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o750 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diretório de imagens inválido.');
  }
}

export function isStorageConfigured() { return true; }
export async function ensureStorage() {
  if (process.env.NODE_ENV === 'production' && (!process.env.STORAGE_DIR || !isAbsolute(process.env.STORAGE_DIR))) throw new Error('Configure STORAGE_DIR com o caminho absoluto do volume persistente.');
  if (process.env.NODE_ENV !== 'production') await mkdir(directory, { recursive: true, mode: 0o750 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('STORAGE_DIR deve ser um diretório real.');
  if (process.env.NODE_ENV === 'production') {
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    const actual = await realpath(directory);
    const mounted = mountInfo.split('\n').some(line => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === actual);
    if (!mounted) throw new Error('STORAGE_DIR precisa ser um volume montado no contêiner.');
  }
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  const probe = join(directory, `.write-test-${randomUUID()}`);
  const file = await open(probe, 'wx', 0o600);
  try { await file.writeFile('ok'); } finally { await file.close(); await unlink(probe); }
}
export async function putImage(key, body) {
  const target = targetPath(key);
  await checkDirectories(dirname(target), true);
  const temporary = join(dirname(target), `.upload-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o640);
  try {
    await file.writeFile(body);
    await file.close();
    // A hard link publishes complete bytes atomically without overwriting an existing image.
    const { link } = await import('node:fs/promises');
    await link(temporary, target);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export async function getImage(key) {
  const target = targetPath(key);
  try {
    await checkDirectories(dirname(target));
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error('Imagem não encontrada.'), { code: 'ENOENT' });
  } catch (error) { if (error.code === 'ENOENT') error.name = 'NoSuchKey'; throw error; }
  return { Body: createReadStream(target), ContentType: types[extname(target)], CacheControl: 'public, max-age=31536000, immutable' };
}
export async function deleteImage(key) {
  const target = targetPath(key);
  try { await checkDirectories(dirname(target)); await unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function closeStorage() {}
