const eyeIcon='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
function addPasswordToggles(root){
  const inputs=[];
  if(root.matches?.('input[type="password"][name="password"]'))inputs.push(root);
  root.querySelectorAll?.('input[type="password"][name="password"]').forEach(input=>inputs.push(input));
  for(const input of inputs){
    if(input.parentElement?.classList.contains('password-field'))continue;
    const wrapper=document.createElement('span'),button=document.createElement('button');
    wrapper.className='password-field';button.type='button';button.className='password-toggle';button.setAttribute('aria-label','Mostrar senha');button.setAttribute('aria-pressed','false');button.innerHTML=eyeIcon;
    input.before(wrapper);wrapper.append(input,button);
    button.addEventListener('click',()=>{const show=input.type==='password';input.type=show?'text':'password';button.setAttribute('aria-label',show?'Ocultar senha':'Mostrar senha');button.setAttribute('aria-pressed',String(show));});
  }
}
addPasswordToggles(document);
new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===Node.ELEMENT_NODE)addPasswordToggles(node)}).observe(document.body,{childList:true,subtree:true});
