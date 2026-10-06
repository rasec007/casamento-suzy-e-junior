import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRsvpConfirmation } from '../server/evolution.js';

test('sends the RSVP confirmation to a Brazilian number with country code', async () => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 201 };
  };
  const sent = await sendRsvpConfirmation(
    { name: 'Família Exemplo', whatsapp: '(85) 98858-4800', companions: 2 },
    { EVOLUTION_API_URL: 'https://evolution.example/message/sendText/wedding', EVOLUTION_API_KEY: 'test-key' },
    fakeFetch,
  );

  assert.equal(sent, true);
  assert.equal(request.url, 'https://evolution.example/message/sendText/wedding');
  assert.equal(request.options.headers.apikey, 'test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    number: '5585988584800',
    text: 'Olá, Família Exemplo! Sua presença no casamento de Suzy & Junior, em 18 de março de 2027, está confirmada para 3 pessoas. Será uma alegria celebrar com você!',
  });
});

test('does not duplicate a country code already supplied', async () => {
  let payload;
  await sendRsvpConfirmation(
    { name: 'Pessoa', whatsapp: '+55 (85) 98858-4800', companions: 0 },
    { EVOLUTION_API_URL: 'https://evolution.example/send', EVOLUTION_API_KEY: 'test-key' },
    async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, status: 201 }; },
  );
  assert.equal(payload.number, '5585988584800');
  assert.match(payload.text, /confirmada para 1 pessoa\./);
});

test('surfaces API failures so the RSVP handler can record a failed notification', async () => {
  await assert.rejects(
    sendRsvpConfirmation(
      { name: 'Pessoa', whatsapp: '85988584800', companions: 0 },
      { EVOLUTION_API_URL: 'https://evolution.example/send', EVOLUTION_API_KEY: 'test-key' },
      async () => ({ ok: false, status: 503 }),
    ),
    /HTTP 503/,
  );
});
