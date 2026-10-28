// Import the images currently exposed by a wedding site before switching storage.
import { ensureStorage, getImage, putImage } from '../server/storage.js';
import { createHash } from 'node:crypto';

const [originText, slug] = process.argv.slice(2);
let origin;
try { origin = new URL(originText); } catch { throw new Error('Uso: node scripts/import-public-images.js https://SITE casamento-slug'); }
if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '')) throw new Error('Informe a origem HTTPS do site e um slug válido.');
await ensureStorage();
async function fetchSafe(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Falha HTTP ${response.status} ao ler ${url.pathname}.`);
  return response;
}
const siteUrl = new URL('/api/site', origin); siteUrl.searchParams.set('wedding', slug);
const site = await (await fetchSafe(siteUrl)).json();
const keys = new Set();
function collect(value) {
  if (typeof value === 'string' && value.startsWith('/media/')) keys.add(value.slice('/media/'.length));
  else if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
}
collect(site);
let imported=0,existing=0;
for (const key of keys) {
  const response = await fetchSafe(new URL(`/media/${key}`, origin));
  const length = Number(response.headers.get('content-length'));
  if (length > 5 * 1024 * 1024) throw new Error(`Imagem excede 5 MB: ${key}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 5 * 1024 * 1024) throw new Error(`Imagem excede 5 MB: ${key}`);
  try { await putImage(key, data); imported++; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current=await getImage(key), chunks=[];
    for await (const chunk of current.Body) chunks.push(chunk);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    if (hash(Buffer.concat(chunks)) !== hash(data)) throw new Error(`Arquivo existente é diferente: ${key}`, { cause: error });
    existing++;
  }
}
console.log(`Imagens localizadas: ${keys.size}; importadas: ${imported}; já existentes e idênticas: ${existing}.`);
console.log('Confira também backups ou arquivos não expostos pela API antes de desativar o armazenamento anterior.');
