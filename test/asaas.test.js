import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asaasRequest, decryptSecret, encryptSecret, secureTokenMatches, hashWebhookToken } from '../server/asaas.js';

const withEncryptionKey = async callback => {
  const previous = process.env.PAYMENTS_ENCRYPTION_KEY;
  process.env.PAYMENTS_ENCRYPTION_KEY = 'a'.repeat(64);
  try { await callback(); }
  finally { if (previous === undefined) delete process.env.PAYMENTS_ENCRYPTION_KEY; else process.env.PAYMENTS_ENCRYPTION_KEY = previous; }
};

test('encrypts and decrypts API secrets with authenticated AES encryption', async () => withEncryptionKey(async () => {
  const encrypted = encryptSecret('asaas-test-api-key-123456');
  assert.notEqual(encrypted, 'asaas-test-api-key-123456');
  assert.equal(decryptSecret(encrypted), 'asaas-test-api-key-123456');
  assert.notEqual(encryptSecret('asaas-test-api-key-123456'), encrypted);
}));

test('validates Webhook tokens using a fixed-time hash comparison', () => {
  const token = 'long-random-webhook-token-for-tests-0123456789';
  const hash = hashWebhookToken(token).toString('hex');
  assert.equal(secureTokenMatches(token, hash), true);
  assert.equal(secureTokenMatches(`${token}-wrong`, hash), false);
  assert.equal(secureTokenMatches(undefined, hash), false);
});

test('sends Asaas credentials only to the selected official environment', async () => {
  let request;
  const response = await asaasRequest('sandbox', 'sandbox-secret', '/myAccount', {
    fetchImpl: async (url, options) => { request = {url,options}; return {ok:true,json:async()=>({name:'Conta de teste'})}; },
  });
  assert.equal(request.url, 'https://api-sandbox.asaas.com/v3/myAccount');
  assert.equal(request.options.headers.access_token, 'sandbox-secret');
  assert.equal(response.name, 'Conta de teste');
  await assert.rejects(asaasRequest('sandbox','secret','//attacker.example'), /Ambiente ou rota Asaas inválidos/);
});

test('surfaces Asaas validation errors without exposing credentials', async () => {
  await assert.rejects(asaasRequest('production','private-key','/myAccount',{
    fetchImpl:async()=>({ok:false,status:401,json:async()=>({errors:[{description:'Chave inválida'}]})}),
  }),error=>error.message==='Asaas: Chave inválida'&&!error.message.includes('private-key'));
});
