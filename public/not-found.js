const form = document.querySelector('#site-url-form');
const input = document.querySelector('#site-url');
const status = document.querySelector('#url-status');
const currentSlug = location.pathname.match(/^\/casamento\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1];
if (currentSlug) input.value = `${location.origin}/casamento/${currentSlug}`;

form.addEventListener('submit', event => {
  event.preventDefault();
  const value = input.value.trim();
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    location.assign(`/casamento/${value}`);
    return;
  }
  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    status.textContent = 'Digite uma URL válida ou somente o slug do casamento.';
    return;
  }
  const match = url.pathname.match(/^\/casamento\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (!match) {
    status.textContent = 'A URL precisa conter /casamento/ seguido do slug.';
    return;
  }
  if (url.origin !== location.origin) {
    status.textContent = 'Este endereço pertence a outro domínio. Abra o link oficial recebido dos noivos.';
    return;
  }
  location.assign(`/casamento/${match[1]}`);
});
