import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const endpoints = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};
const checkoutHosts = { sandbox: 'sandbox.asaas.com', production: 'asaas.com' };

export function asaasCheckoutUrl(environment, checkout) {
  const host = checkoutHosts[environment];
  if (!host || !checkout || typeof checkout.id !== 'string' || !/^[a-z\d-]{1,80}$/i.test(checkout.id)) {
    throw new Error('O Asaas retornou um identificador de checkout inválido.');
  }
  const url = new URL(checkout.link || `/checkoutSession/show?id=${encodeURIComponent(checkout.id)}`, `https://${host}`);
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password) {
    throw new Error('O Asaas retornou um endereço de checkout inesperado.');
  }
  return url.toString();
}

function encryptionKey() {
  const value = process.env.PAYMENTS_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Configure PAYMENTS_ENCRYPTION_KEY como 64 caracteres hexadecimais aleatórios.');
  return Buffer.from(value, 'hex');
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('hex')).join('.');
}

export function decryptSecret(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || '').split('.');
  if (!ivHex || !tagHex || !encryptedHex) throw new Error('Credencial de pagamento armazenada em formato inválido.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

export function hashWebhookToken(value) {
  return createHash('sha256').update(value).digest();
}

export function secureTokenMatches(received, expectedHash) {
  if (typeof received !== 'string' || !expectedHash) return false;
  const suppliedHash = hashWebhookToken(received);
  const storedHash = Buffer.from(expectedHash, 'hex');
  return storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);
}

export async function asaasRequest(environment, apiKey, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const base = endpoints[environment];
  if (!base || !path.startsWith('/') || path.startsWith('//')) throw new Error('Ambiente ou rota Asaas inválidos.');
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: { accept: 'application/json', access_token: apiKey, 'content-type': 'application/json', 'user-agent': 'WeddingSite/1.0' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.errors?.map(item => item.description).filter(Boolean).join(' ') || `HTTP ${response.status}`;
    throw new Error(`Asaas: ${detail.slice(0, 300)}`);
  }
  return payload;
}
