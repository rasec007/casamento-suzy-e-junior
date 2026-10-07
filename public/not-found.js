const form = document.querySelector('#site-url-form');
const input = document.querySelector('#site-url');
const status = document.querySelector('#url-status');
const loginForm = document.querySelector('#admin-login-form');
const loginStatus = document.querySelector('#login-status');
const weddingChoice = document.querySelector('#wedding-choice');
const currentSlug = location.pathname.match(/^\/casamento\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1];
if (currentSlug) input.value = `${location.origin}/casamento/${currentSlug}`;

document.querySelector('#show-admin-login').addEventListener('click', () => {
  loginForm.hidden = false;
  loginForm.querySelector('[name="email"]').focus();
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm));
  const selectedWedding = weddingChoice.querySelector('select')?.value;
  loginStatus.textContent = 'Validando acesso…';
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type':'application/json', ...(selectedWedding ? {'x-wedding-slug':selectedWedding} : {})},
      body: JSON.stringify({email:data.email,password:data.password})
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && Array.isArray(result.weddings)) {
      weddingChoice.replaceChildren();
      const label=document.createElement('label'),select=document.createElement('select');
      label.htmlFor='wedding-select';label.textContent='Escolha o casamento';select.id='wedding-select';select.required=true;
      for(const wedding of result.weddings){const option=document.createElement('option');option.value=wedding.slug;option.textContent=wedding.title;select.append(option)}
      weddingChoice.append(label,select);
      loginStatus.textContent = result.error;
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Não foi possível entrar. Confira o e-mail e a senha.');
    location.assign(`/casamento/${encodeURIComponent(result.wedding.slug)}?painel=1`);
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

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
