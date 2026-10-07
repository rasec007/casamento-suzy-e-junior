(() => {
  const layer = document.querySelector('#toast-dialog');
  const toast = document.querySelector('#toast');
  if (!layer || !toast) return;

  let timer;
  window.showToast = (message, type = 'success') => {
    const text = String(message ?? '').trim();
    if (!text) return;
    toast.textContent = text;
    toast.dataset.type = type;
    toast.classList.add('show');
    if (!layer.open) layer.show();
    clearTimeout(timer);
    timer = setTimeout(() => {
      toast.classList.remove('show');
      if (layer.open) layer.close();
    }, 5000);
  };

  const statusSelector = '[role="status"], .form-status';
  const notified = new WeakMap();
  const observer = new MutationObserver(records => {
    const candidates = new Set();
    const addIfStatus = element => {
      if (!(element instanceof Element)) return;
      if (element.matches(statusSelector)) candidates.add(element);
      element.querySelectorAll(statusSelector).forEach(candidate => candidates.add(candidate));
    };
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      addIfStatus(target);
      record.addedNodes?.forEach(node => { if (node.nodeType === Node.ELEMENT_NODE) addIfStatus(node); });
    }
    for (const element of candidates) {
      if (element.closest('#toast-dialog')) continue;
      const message = element.textContent.trim();
      if (!message) { notified.delete(element); continue; }
      if (notified.get(element) === message) continue;
      notified.set(element, message);
      const loading = /^(salvando|validando|consultando|criando|enviando|carregando|atualizando|excluindo)/i.test(message);
      const failure = /(inv[aá]lid|erro|falha|gateway|\b50[0234]\b|tempo limite|indispon[ií]vel|n[aã]o (foi poss[ií]vel|encontrad|cadastrad|permitid|pode)|obrigat|necess[aá]ri|confira|limite|excedid|encerrad)/i.test(message);
      element.textContent = '';
      window.showToast(message, loading ? 'info' : failure ? 'error' : 'success');
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
})();
