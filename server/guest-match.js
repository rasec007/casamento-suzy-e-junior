export const normalizeBrazilianPhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith('55') && [12, 13].includes(digits.length) ? digits.slice(2) : digits;
};

export const normalizeGuestName = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .replace(/[^\p{L}\p{N}]/gu, '');
