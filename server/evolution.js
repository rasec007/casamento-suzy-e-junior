const toBrazilianWhatsAppNumber = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) throw new Error('WhatsApp sem número válido.');
  if (String(value).trim().startsWith('+') || digits.startsWith('55')) return digits;
  return `55${digits}`;
};

export async function sendRsvpConfirmation({ name, whatsapp, companions }, env = process.env, fetchImpl = fetch) {
  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY) throw new Error('EvolutionAPI não configurada.');
  const number = toBrazilianWhatsAppNumber(whatsapp);
  const people = 1 + Number(companions || 0);
  const text = `Olá, ${name}! Sua presença no casamento de Suzy & Junior, em 18 de março de 2027, está confirmada para ${people} ${people === 1 ? 'pessoa' : 'pessoas'}. Será uma alegria celebrar com você!`;
  const response = await fetchImpl(env.EVOLUTION_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`EvolutionAPI respondeu HTTP ${response.status}.`);
  return true;
}
