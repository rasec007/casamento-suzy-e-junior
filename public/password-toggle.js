let passwordRequirementsId=0;
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
    if(input.autocomplete==='new-password'){
      const rules=[['Pelo menos 12 caracteres',value=>value.length>=12],['Uma letra',value=>/\p{L}/u.test(value)],['Um número',value=>/\p{N}/u.test(value)],['Uma letra maiúscula',value=>/\p{Lu}/u.test(value)],['Um caractere especial',value=>/[^\p{L}\p{N}\s]/u.test(value)]];
      const list=document.createElement('ul');list.className='password-requirements';list.id=`password-requirements-${++passwordRequirementsId}`;
      const items=rules.map(([label])=>{const item=document.createElement('li');item.textContent=label;list.append(item);return item});
      const label=wrapper.closest('label');(label||wrapper).after(list);input.setAttribute('aria-describedby',list.id);
      const update=()=>{let valid=true;rules.forEach(([,check],index)=>{const met=check(input.value);items[index].classList.toggle('met',met);items[index].setAttribute('aria-label',`${rules[index][0]}: ${met?'atingido':'não atingido'}`);valid=valid&&met});input.setCustomValidity(valid?'':'A senha deve cumprir todos os requisitos indicados.');};
      input.addEventListener('input',update);update();
    }
  }
}
addPasswordToggles(document);
new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===Node.ELEMENT_NODE)addPasswordToggles(node)}).observe(document.body,{childList:true,subtree:true});
