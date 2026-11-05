(() => {
  const root=document.body.dataset.root||'.';
  const config=window.TERRAOI_BRANDS;
  const selector=document.querySelector('[data-mode-selector]');
  const requested=new URLSearchParams(location.search).get('brand');
  const mode=Object.hasOwn(config.modes,requested)?requested:config.defaultMode;
  const b=config.modes[mode];
  document.documentElement.style.setProperty('--primary',b.primary);
  document.documentElement.style.setProperty('--on-primary',b.onPrimary);
  document.documentElement.style.setProperty('--accent',b.accent);
  document.title=b.name+' | '+document.body.dataset.page;
  document.querySelectorAll('[data-brand]').forEach(el=>{el.textContent=b[el.dataset.brand]||''});
  document.querySelectorAll('[data-logo]').forEach(el=>{el.src=root+'/'+b.logo;el.alt=b.name});
  document.querySelectorAll('[data-powered]').forEach(el=>{el.hidden=!b.showPoweredBy;el.textContent=b.showPoweredBy?'Powered by TerraOI':''});
  document.querySelectorAll('[data-internal]').forEach(el=>{const u=new URL(el.getAttribute('href'),location.href);u.searchParams.set('brand',mode);el.href=u.href});
  const icon=document.querySelector('link[rel="icon"]'); if(icon)icon.href=root+'/'+b.favicon;
  if(selector){selector.value=mode;selector.addEventListener('change',()=>{const u=new URL(location.href);u.searchParams.set('brand',selector.value);location.href=u.href})}
  document.querySelectorAll('[data-print]').forEach(el=>el.addEventListener('click',()=>window.print()));
  const form=document.querySelector('[data-login]');if(form)form.addEventListener('submit',e=>{e.preventDefault();document.querySelector('[data-login-message]').textContent='Preview only. No credentials are sent or stored. Opening the sample dashboard.';setTimeout(()=>location.href='dashboard.html?brand='+mode,600)});
  document.querySelectorAll('[data-demo-action]').forEach(el=>el.addEventListener('click',()=>{const target=document.querySelector('[data-action-message]');if(target)target.textContent='Preview only. This action requires a connected operations system and approval.'}));
})();
