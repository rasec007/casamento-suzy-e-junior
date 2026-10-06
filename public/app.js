const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]);
const brl = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
const state = { gifts:[], memories:[], guests:[], admin:null, category:'Todos', search:'', adminTab:'visao-geral', adminSearch:'' };
const categories=['Todos','Lua de Mel','Novo Lar','Experiências','Família & Pets'];
const revealTargets='.section > .eyebrow,.section > h2,.section-head,.manuscript,.venue,.gift-card,.memory-card,.rsvp-box,.mirror,.guest-card,body > footer > *';
const revealObserver='IntersectionObserver'in window?new IntersectionObserver(entries=>{for(const entry of entries)entry.target.classList.toggle('is-visible',entry.isIntersecting)},{threshold:0.12,rootMargin:'0px 0px -6% 0px'}):null;
if(revealObserver&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
  document.documentElement.classList.add('motion-ready');
  const observeReveals=root=>{if(root.matches?.(revealTargets)){root.dataset.reveal='';revealObserver.observe(root)}root.querySelectorAll?.(revealTargets).forEach(element=>{element.dataset.reveal='';revealObserver.observe(element)})};
  observeReveals(document);
  new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===Node.ELEMENT_NODE)observeReveals(node)}))).observe(document.querySelector('main'),{childList:true,subtree:true});
}
async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...options.headers},credentials:'same-origin'});
  const payload=response.status===204?{}:await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(payload.error||'Não foi possível concluir a solicitação.');
  return payload;
}
function notify(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');clearTimeout(notify.timer);notify.timer=setTimeout(()=>toast.classList.remove('show'),3200)}
function renderGifts(){
  $('#categories').innerHTML=categories.map(category=>`<button type="button" data-category="${esc(category)}" class="${category===state.category?'active':''}">${esc(category)}</button>`).join('');
  const gifts=state.category==='Todos'?state.gifts:state.gifts.filter(gift=>gift.category===state.category);
  $('#gifts').innerHTML=gifts.map(gift=>`<article class="gift-card"><div><p class="eyebrow">${esc(gift.category)}</p><h3>${esc(gift.title)}</h3><p>${esc(gift.description)}</p></div><div><div class="price"><span>Valor do presente</span><b>${brl(gift.price)}</b></div><button class="outline" data-gift="${esc(gift.id)}">Presentear</button></div></article>`).join('')||'<p class="muted">Nenhum presente nesta categoria.</p>';
}
function renderMemories(){
  $('#memories').innerHTML=state.memories.map(memory=>`<article class="memory-card"><blockquote>“${esc(memory.message||'Com carinho, celebramos o casamento de Suzy & Junior.')}”</blockquote><footer><span class="memory-by">${esc(memory.senderName)}</span><div class="memory-meta"><span>Presente: <b>${esc(memory.giftTitle)}</b></span><time>${esc(memory.createdAt)}</time></div></footer></article>`).join('')||'<p class="muted">As primeiras lembranças aparecerão aqui.</p>';
}
function renderGuests(){
  const visible=state.guests, q=state.search.trim().toLocaleLowerCase('pt-BR');
  $('#guest-count').textContent=`${visible.length} famílias confirmadas · ${visible.reduce((sum,g)=>sum+1+g.companions,0)} convidados no total`;
  const filtered=visible.filter(guest=>guest.name.toLocaleLowerCase('pt-BR').includes(q));
  $('#guests').innerHTML=filtered.map(guest=>`<article class="guest-card"><b>${esc(guest.name)}</b><span>${guest.companions?`+${guest.companions} acompanhante(s)`:'Presença individual'} · ${esc(guest.confirmedAt)}</span></article>`).join('')||'<p class="muted">Nenhum nome encontrado.</p>';
}
async function loadSite(){const data=await api('/api/site');state.gifts=data.gifts;state.memories=data.memories;state.guests=data.guests;renderGifts();renderMemories();renderGuests()}
function openGift(gift){
  const dialog=$('#gift-dialog');
  dialog.innerHTML=`<div class="dialog-inner"><div class="dialog-head"><div><p class="eyebrow">${esc(gift.category)}</p><h2 id="gift-dialog-title">${esc(gift.title)}</h2><b class="price-value">${brl(gift.price)}</b></div><button class="icon-button" data-close aria-label="Fechar">×</button></div><p class="muted">Deixe seu carinho na Penseira. Esta versão registra a intenção do presente; o pagamento será combinado diretamente com os noivos.</p><form id="memory-form" class="dialog-form"><label>Seu nome / família *<input name="senderName" maxlength="120" required autocomplete="name"></label><label>WhatsApp com DDD *<input name="whatsapp" maxlength="24" inputmode="tel" required autocomplete="tel"></label><label>Mensagem aos noivos<textarea name="message" maxlength="1000" placeholder="Um recado carinhoso"></textarea></label><button class="gold-button">Registrar presente e mensagem</button><p class="form-status" role="status"></p></form></div>`;
  dialog.showModal();
  $('#memory-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const button=$('button[type="submit"]',form);button.disabled=true;try{await api('/api/memories',{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(form)),giftId:gift.id})});form.reset();dialog.close();notify('Sua mensagem foi adicionada à Penseira.');await loadSite()}catch(error){$('.form-status',form).textContent=error.message}finally{button.disabled=false}});
}
const tabs=[['visao-geral','Visão geral'],['presentes','Penseira'],['convidados','Convidados'],['fornecedores','Fornecedores']];
function recordRows(){
  const lists={
    presentes:state.admin.memories.map(r=>({kind:'memories',id:r.id,title:r.senderName,detail:`${r.giftTitle} · ${brl(r.giftAmount)}`,visible:r.isVisible,edit:[['senderName','Nome',r.senderName],['message','Mensagem',r.message]]})),
    convidados:state.admin.guests.map(r=>({kind:'guests',id:r.id,title:r.name,detail:`WhatsApp ${r.whatsapp} · ${r.companions} acompanhante(s)`,visible:r.isVisible,edit:[['name','Nome',r.name],['companions','Acompanhantes',r.companions]]})),
    fornecedores:state.admin.suppliers.map(r=>({kind:'suppliers',id:r.id,title:r.name,detail:`${r.role} · ${brl(r.cost)} (pago ${brl(r.paidAmount)}) · ${r.status}`,visible:r.isVisible,edit:[['name','Nome',r.name],['role','Função',r.role],['contact','Contato',r.contact],['cost','Custo',r.cost],['paidAmount','Valor pago',r.paidAmount],['status','Status',r.status]]}))
  };
  return state.adminTab==='visao-geral'?[...lists.presentes,...lists.convidados,...lists.fornecedores]:lists[state.adminTab];
}
function renderAdmin(){
  if(!state.admin)return;
  const data=state.admin, allRows=recordRows(), q=state.adminSearch.toLocaleLowerCase('pt-BR'), rows=allRows.filter(r=>`${r.title} ${r.detail}`.toLocaleLowerCase('pt-BR').includes(q));
  const giftsTotal=data.memories.reduce((n,m)=>n+m.giftAmount,0), supplierCost=data.suppliers.reduce((n,s)=>n+s.cost,0), paid=data.suppliers.reduce((n,s)=>n+s.paidAmount,0);
  $('#admin-content').innerHTML=`<div class="admin"><header class="admin-header"><h2 id="admin-dialog-title">Painel dos Noivos</h2><div class="admin-actions"><button class="outline" id="new-supplier">+ Fornecedor</button><button class="outline" id="admin-logout">Sair</button><button class="icon-button" data-close aria-label="Fechar painel">×</button></div></header><nav class="admin-nav">${tabs.map(([id,label])=>`<button data-tab="${id}" class="${id===state.adminTab?'active':''}">${label}</button>`).join('')}</nav><div class="stats"><div class="stat"><span>Intenção de presentes (sem pagamento)</span><b>${brl(giftsTotal)}</b></div><div class="stat"><span>Custo de fornecedores</span><b>${brl(supplierCost)}</b></div><div class="stat"><span>Pago aos fornecedores</span><b>${brl(paid)}</b></div></div><label class="search-label">Buscar<input id="admin-search" type="search" value="${esc(state.adminSearch)}" placeholder="Nome, presente ou fornecedor"></label><div class="table-wrap"><table><thead><tr><th>Registro</th><th>Detalhes</th><th>Visibilidade</th><th>Ações</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.title)}</td><td>${esc(r.detail)}</td><td>${r.visible?'Visível':'Oculto'}</td><td><button class="outline" data-toggle="${r.kind}" data-id="${esc(r.id)}" data-visible="${r.visible}">${r.visible?'Ocultar':'Exibir'}</button> <button class="outline" data-edit="${r.kind}" data-id="${esc(r.id)}">Editar</button> <button class="outline" data-delete="${r.kind}" data-id="${esc(r.id)}">Excluir</button></td></tr>`).join('')||'<tr><td colspan="4">Nenhum registro.</td></tr>'}</tbody></table></div><p class="form-status" id="admin-status" role="status"></p></div>`;
  $('#admin-dialog').classList.add('admin');
}
async function loadAdmin(){state.admin=await api('/api/admin/data');renderAdmin()}
async function adminAction(action){
  const content=$('#admin-content');
  if(action==='login'){
    content.innerHTML=`<div class="dialog-inner"><div class="dialog-head"><div><p class="eyebrow">ÁREA RESTRITA</p><h2 id="admin-dialog-title">Acesso dos Noivos</h2></div><button class="icon-button" data-close aria-label="Fechar">×</button></div><form id="login-form" class="dialog-form"><label>Senha administrativa<input name="password" type="password" required autocomplete="current-password" maxlength="200"></label><button class="gold-button">Entrar</button><p class="form-status" role="status"></p></form></div>`;
    $('#login-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:new FormData(form).get('password')})});await loadAdmin()}catch(error){$('.form-status',form).textContent=error.message}});
  }
}
$('#categories').addEventListener('click',event=>{const button=event.target.closest('[data-category]');if(button){state.category=button.dataset.category;renderGifts()}});
$('#gifts').addEventListener('click',event=>{const button=event.target.closest('[data-gift]');if(button){const gift=state.gifts.find(item=>item.id===button.dataset.gift);if(gift)openGift(gift)}});
$('#gift-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget||event.target.closest('[data-close]'))event.currentTarget.close()});
$('#rsvp-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget, status=$('.form-status',form), button=$('button',form);button.disabled=true;status.textContent='';try{const data=Object.fromEntries(new FormData(form));data.companions=Number(data.companions);const result=await api('/api/rsvp',{method:'POST',body:JSON.stringify(data)});const name=data.name;form.reset();status.textContent=`Presença de ${name} confirmada${result.notificationSent?' — enviamos a confirmação por WhatsApp.':'; não foi possível enviar o WhatsApp agora, mas o RSVP foi salvo.'} Seu reflexo aparecerá no Espelho.`;await loadSite()}catch(error){status.textContent=error.message}finally{button.disabled=false}});
$('#mirror-search').addEventListener('input',event=>{state.search=event.target.value;renderGuests()});
$('#admin-open').addEventListener('click',async()=>{const dialog=$('#admin-dialog');dialog.showModal();try{await loadAdmin()}catch(error){state.admin=null;await adminAction('login')}});
$('#admin-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget||event.target.closest('[data-close]'))event.currentTarget.close()});
$('#admin-dialog').addEventListener('close',()=>{state.admin=null});
$('#admin-content').addEventListener('click',async event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.id==='admin-logout'){await api('/api/admin/logout',{method:'POST'});state.admin=null;$('#admin-dialog').close();notify('Sessão encerrada.');return}
  if(target.id==='new-supplier'){const dialog=$('#gift-dialog');dialog.innerHTML=`<div class="dialog-inner"><div class="dialog-head"><h2 id="gift-dialog-title">Novo fornecedor</h2><button class="icon-button" data-close aria-label="Fechar">×</button></div><form id="supplier-form" class="dialog-form"><label>Nome<input name="name" maxlength="120" required></label><label>Função<input name="role" maxlength="180" required></label><label>Contato<input name="contact" maxlength="80"></label><label>Custo total<input name="cost" type="number" min="0" step="0.01" value="0" required></label><button class="gold-button">Adicionar fornecedor</button><p class="form-status" role="status"></p></form></div>`;dialog.showModal();$('#supplier-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,data=Object.fromEntries(new FormData(form));data.cost=Number(data.cost);try{await api('/api/admin/suppliers',{method:'POST',body:JSON.stringify(data)});dialog.close();await loadAdmin();notify('Fornecedor adicionado.')}catch(error){$('.form-status',form).textContent=error.message}});return}
  if(target.dataset.tab){state.adminTab=target.dataset.tab;renderAdmin();return}
  const kind=target.dataset.toggle||target.dataset.delete||target.dataset.edit,id=target.dataset.id;if(!kind||!id)return;
  try{
    if(target.dataset.toggle){await api(`/api/admin/${kind}/${id}`,{method:'PATCH',body:JSON.stringify({isVisible:target.dataset.visible!=='true'})})}
    if(target.dataset.delete){if(!confirm('Excluir este registro permanentemente?'))return;await api(`/api/admin/${kind}/${id}`,{method:'DELETE'})}
    if(target.dataset.edit){const row=recordRows().find(item=>item.kind===kind&&item.id===id);if(!row)return;const values={};for(const [field,label,value] of row.edit){const next=prompt(label,value??'');if(next===null)return;values[field]=['companions','cost','paidAmount'].includes(field)?Number(next):next}await api(`/api/admin/${kind}/${id}`,{method:'PATCH',body:JSON.stringify(values)})}
    await loadAdmin();await loadSite();
  }catch(error){$('#admin-status').textContent=error.message}
});
$('#admin-content').addEventListener('input',event=>{if(event.target.id==='admin-search'){state.adminSearch=event.target.value;const cursor=event.target.selectionStart;renderAdmin();$('#admin-search').focus();$('#admin-search').setSelectionRange(cursor,cursor)}});
$('#menu-toggle').addEventListener('click',()=>{const nav=$('#nav'),open=nav.classList.toggle('open');$('#menu-toggle').setAttribute('aria-expanded',String(open))});
$('#nav').addEventListener('click',event=>{if(event.target.closest('a')){$('#nav').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false')}});
const targetDate=new Date('2027-03-18T10:00:00-03:00');function updateCountdown(){let seconds=Math.max(0,Math.floor((targetDate-Date.now())/1000));const values={days:Math.floor(seconds/86400),hours:Math.floor(seconds%86400/3600),minutes:Math.floor(seconds%3600/60),seconds:seconds%60};for(const [id,value] of Object.entries(values))$('#'+id).textContent=String(value).padStart(2,'0')};updateCountdown();setInterval(updateCountdown,1000);
try{await loadSite()}catch(error){notify('Não foi possível carregar os dados. Verifique se o servidor e o banco estão ativos.')}
if('EventSource'in window){const events=new EventSource('/api/events');events.addEventListener('update',()=>{loadSite().catch(()=>{});if(state.admin)loadAdmin().catch(()=>{state.admin=null;if($('#admin-dialog').open){$('#admin-dialog').close();notify('Sua sessão administrativa terminou.')}})})}
