(function(){
  'use strict';

  const page=((location.pathname||'').split('/').pop()||'admin.html').toLowerCase();
  if(page==='login-admin.html'||document.getElementById('mtd-dashboard-shell'))return;

  const routes={
    'admin.html':{icon:'layout-dashboard',title:'Tableau de bord',subtitle:'Vue opérationnelle du laboratoire, alimentée par les données de production.'},
    'admin-isolement.html':{icon:'flask-conical',title:'Isolement tissulaire',subtitle:'Gestion des isolations, géloses, boîtes de Petri, QR et cycles P1 / P2 / P3.'},
    'admin-isolement-journal.html':{icon:'clipboard-pen-line',title:'Journal d’isolement',subtitle:'Observation quotidienne, photos, scores, piquage, validation et traçabilité de la boîte.'},
    'admin-myc-liquide.html':{icon:'beaker',title:'Mycélium liquide',subtitle:'P3 transférables, solutions nutritives, lots LC, validation et stockage.'},
    'admin-lc-cycle.html':{icon:'test-tube-2',title:'Journal LC',subtitle:'Suivi pot par pot, contrôles quotidiens, photos, qualité et conservation.'},
    'admin-myc-grain.html':{icon:'wheat',title:'Mycélium sur grain',subtitle:'Préparation, inoculation, suivi des unités et traçabilité des sources LC / P3.'},
    'admin-myc-grain-journal.html':{icon:'notebook-tabs',title:'Journal grain',subtitle:'Suivi quotidien de la propagation, qualité, photos et statut de chaque unité.'},
    'admin-souches.html':{icon:'sprout',title:'Souches',subtitle:'Bibliothèque biologique, certification, provenance, échéances et disponibilité.'},
    'admin-souche-journal.html':{icon:'dna',title:'Journal de souche',subtitle:'Historique et traçabilité détaillée de la souche sélectionnée.'},
    'admin-taches.html':{icon:'clipboard-check',title:'Tâches obligatoires',subtitle:'Contrôles réellement dus aujourd’hui, retards et échéances calculés depuis la base.'},
    'admin-users.html':{icon:'users',title:'Utilisateurs et approbations',subtitle:'Accès, rôles, activité de production et demandes de suppression.'},
    'change-password.html':{icon:'key-round',title:'Sécurité du compte',subtitle:'Mise à jour du mot de passe utilisateur.'}
  };

  const activeNavPage={
    'admin-isolement-journal.html':'admin-isolement.html',
    'admin-lc-cycle.html':'admin-myc-liquide.html',
    'admin-myc-grain-journal.html':'admin-myc-grain.html',
    'admin-souche-journal.html':'admin-souches.html'
  }[page]||page;

  const nav=[
    ['admin.html','layout-dashboard','Tableau de bord'],
    ['admin-isolement.html','flask-conical','Isolement tissulaire'],
    ['admin-myc-liquide.html','beaker','Mycélium liquide (LC)'],
    ['admin-myc-grain.html','wheat','Mycélium sur grain'],
    ['admin-souches.html','sprout','Souches'],
    ['admin-taches.html','clipboard-check','Tâches obligatoires'],
    ['admin-users.html','users','Utilisateurs','admin']
  ];

  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=v=>v?new Date(v).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'}):'';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let searchTimer=null;
  let iconRefreshTimer=null;

  function iconMarkup(name){return `<i data-lucide="${name}"></i>`}

  function build(){
    if(document.getElementById('mtd-dashboard-shell'))return;
    document.body.classList.add('mtd-dashboard-shell');

    const overlay=document.createElement('div');
    overlay.className='mtd-shell-overlay';overlay.id='mtd-shell-overlay';

    const sidebar=document.createElement('aside');
    sidebar.className='mtd-shell-sidebar';sidebar.id='mtd-dashboard-shell';
    sidebar.innerHTML=`
      <a class="mtd-shell-brand" href="admin.html">
        <img src="images/logo-agro.jpeg" alt="Mycelium Tech Digital">
        <span><strong>MYCELIUM</strong><small>TECH DIGITAL</small></span>
      </a>
      <nav class="mtd-shell-nav">
        ${nav.map(([href,icon,label,role])=>`<a href="${href}"${activeNavPage===href?' class="active"':''}${role?' data-mtd-admin-link hidden':''}>${iconMarkup(icon)}<span>${label}</span></a>`).join('')}
      </nav>
      <section class="mtd-shell-system" id="mtd-shell-system">
        <div class="mtd-shell-system-head"><span>État du système</span><small id="mtd-system-time">—</small></div>
        <strong><span class="mtd-system-dot" id="mtd-system-dot"></span><span id="mtd-system-label">Vérification…</span></strong>
        <p id="mtd-system-copy">Connexion à PostgreSQL et aux services de production.</p>
      </section>
      <div class="mtd-shell-footer">Cultiver l’avenir, naturellement.<br><strong>Mycelium Tech Digital</strong></div>`;

    const top=document.createElement('header');
    top.className='mtd-shell-topbar';
    top.innerHTML=`
      <button class="mtd-shell-menu" type="button" aria-label="Ouvrir le menu">${iconMarkup('menu')}</button>
      <div class="mtd-shell-search-wrap">
        <label class="mtd-shell-search">${iconMarkup('search')}<input id="mtd-global-search" type="search" placeholder="Rechercher boîte, souche, LC, grain…" autocomplete="off" aria-label="Recherche globale"></label>
        <div class="mtd-shell-search-results" id="mtd-search-results"></div>
      </div>
      <span class="mtd-shell-spacer"></span>
      <button class="mtd-shell-icon" id="mtd-shell-bell" type="button" title="Demandes de suppression" aria-label="Demandes de suppression" hidden>${iconMarkup('bell')}<span class="mtd-shell-badge" id="mtd-shell-badge" hidden>0</span></button>
      <div class="mtd-shell-profile"><img src="images/logo-agro.jpeg" alt=""><span><strong id="mtd-shell-name">Utilisateur</strong><small id="mtd-shell-role">Connexion…</small></span></div>
      <button class="mtd-shell-logout" type="button" title="Déconnexion" aria-label="Déconnexion">${iconMarkup('log-out')}</button>`;

    const notifications=document.createElement('section');
    notifications.className='mtd-shell-notifications';notifications.id='mtd-shell-notifications';
    notifications.innerHTML='<h3>Demandes de suppression</h3><div id="mtd-shell-request-list"><div class="mtd-shell-empty">Chargement…</div></div><a href="admin-users.html" class="mtd-shell-review">Gérer les demandes</a>';

    document.body.prepend(overlay,sidebar,top,notifications);
    window.lucide?.createIcons();

    top.querySelector('.mtd-shell-menu').addEventListener('click',()=>{sidebar.classList.toggle('open');overlay.classList.toggle('open')});
    overlay.addEventListener('click',()=>{sidebar.classList.remove('open');overlay.classList.remove('open')});
    top.querySelector('.mtd-shell-logout').addEventListener('click',()=>window.logoutAdmin&&window.logoutAdmin());
    top.querySelector('#mtd-shell-bell').addEventListener('click',event=>{event.stopPropagation();notifications.classList.toggle('open')});
    document.addEventListener('click',event=>{if(!notifications.contains(event.target)&&!event.target.closest('#mtd-shell-bell'))notifications.classList.remove('open')});
    bindSearch();
    injectPageHeader();
    cleanLegacyIcons();
    loadSystemStatus();
    runRouteAction();
    const observer=new MutationObserver(()=>{clearTimeout(iconRefreshTimer);iconRefreshTimer=setTimeout(cleanLegacyIcons,120)});
    observer.observe(document.body,{childList:true,subtree:true});
  }

  function pageHost(){
    return document.querySelector('.admin-wrapper .container,.wrapper .container,main.wrap,main.password-page,section.wrapper .container,body>.container');
  }

  function injectPageHeader(){
    if(page==='admin.html'||document.querySelector('.mtd-page-header'))return;
    const config=routes[page];if(!config)return;
    const host=pageHost();if(!host)return;
    const legacy=host.querySelector(':scope > h1,:scope > h3');if(legacy)legacy.classList.add('mtd-legacy-page-title');
    const header=document.createElement('section');header.className='mtd-page-header';
    header.innerHTML=`<span class="mtd-page-header-icon">${iconMarkup(config.icon)}</span><div class="mtd-page-header-copy"><h1>${esc(config.title)}</h1><p>${esc(config.subtitle)}</p></div><div class="mtd-page-header-actions"><a href="admin.html">${iconMarkup('layout-dashboard')}Tableau de bord</a></div>`;
    host.prepend(header);window.lucide?.createIcons();
  }

  function stripLeadingSymbols(node){
    for(const child of node.childNodes){
      if(child.nodeType===Node.TEXT_NODE&&child.nodeValue&&child.nodeValue.trim()){
        child.nodeValue=child.nodeValue.replace(/^\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F\u200D➕✅❌⚠ℹ]+\s*/u,'');
        return;
      }
      if(child.nodeType===Node.ELEMENT_NODE)stripLeadingSymbols(child);
    }
  }

  function cleanLegacyIcons(){
    const selector='button,.btn-main,.btn-action,.button-primary,.btnx,h2,h3,h4,h5,.image-upload-btn';
    const map=[
      [/scan|qr/i,'scan-line'],[/photo|image|album/i,'image'],[/gelos|agar/i,'flask-round'],[/isolement|petri|boîte/i,'flask-conical'],[/liquide|\blc\b|solution/i,'beaker'],[/grain|sac/i,'wheat'],[/souche/i,'sprout'],[/cycle|timeline/i,'calendar-range'],[/récap|recap|résumé|resume/i,'clipboard-list'],[/supprim|effacer|retirer/i,'trash-2'],[/enregistrer|sauvegard/i,'save'],[/imprimer|étiquette/i,'printer'],[/ajouter|créer|nouveau/i,'circle-plus'],[/retour|fermer|annuler/i,'arrow-left'],[/valider|validation/i,'circle-check'],[/piquer|piquage|repiqu/i,'git-branch'],[/périm|perim/i,'archive-x'],[/stock|frigo|conservation/i,'archive'],[/historique|journal|suivi/i,'notebook-tabs'],[/protocole|compar/i,'chart-no-axes-combined'],[/utilisateur|compte/i,'users'],[/export/i,'download']
    ];
    document.querySelectorAll(selector).forEach(el=>{
      if(el.closest('.mtd-shell-sidebar,.mtd-shell-topbar,.mtd-page-header'))return;
      if(el.querySelector('.mtd-ui-icon,[data-lucide]'))return;
      const text=(el.textContent||'').trim();if(!text)return;
      const found=map.find(([re])=>re.test(text));
      const hasSymbol=/^[\s\u2600-\u27BF\u{1F300}-\u{1FAFF}➕✅❌⚠ℹ]/u.test(text);
      if(!found&&!hasSymbol)return;
      stripLeadingSymbols(el);
      if(found){const icon=document.createElement('i');icon.className='mtd-ui-icon';icon.setAttribute('data-lucide',found[1]);el.prepend(icon)}
    });
    window.lucide?.createIcons();
  }

  function runRouteAction(){
    const params=new URLSearchParams(location.search||'');
    const action=params.get('action');
    if(page==='admin-isolement.html'&&action==='new-isolation'){
      setTimeout(()=>{const button=document.getElementById('btn-new-isolation');if(button){button.click();setTimeout(()=>document.getElementById('form-new-isolation-container')?.scrollIntoView({behavior:'smooth',block:'start'}),80)}},450);
    }
  }

  async function loadSystemStatus(){
    const label=document.getElementById('mtd-system-label'),dot=document.getElementById('mtd-system-dot'),copy=document.getElementById('mtd-system-copy'),time=document.getElementById('mtd-system-time');
    try{
      const response=await fetch('/api/ping',{credentials:'same-origin',cache:'no-store'});const data=await response.json().catch(()=>({}));
      if(!response.ok||data.db!=='ok')throw new Error();
      label.textContent='Opérationnel';dot.classList.remove('error');copy.textContent='PostgreSQL répond correctement. Données de production disponibles.';time.textContent=new Date(data.now||Date.now()).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    }catch(_){label.textContent='Connexion limitée';dot.classList.add('error');copy.textContent='La base de données ne répond pas correctement. Certaines pages peuvent être indisponibles.';time.textContent='—'}
  }

  function bindSearch(){
    const input=document.getElementById('mtd-global-search'),results=document.getElementById('mtd-search-results');if(!input||!results)return;
    input.addEventListener('input',()=>{clearTimeout(searchTimer);const q=input.value.trim();if(q.length<2){results.classList.remove('open');results.innerHTML='';return}results.innerHTML='<div class="mtd-search-empty">Recherche…</div>';results.classList.add('open');searchTimer=setTimeout(()=>runSearch(q),180)});
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){results.classList.remove('open');input.blur()}});
    document.addEventListener('click',event=>{if(!event.target.closest('.mtd-shell-search-wrap'))results.classList.remove('open')});
  }

  async function runSearch(q){
    const results=document.getElementById('mtd-search-results');
    try{
      const response=await fetch('/api/search?q='+encodeURIComponent(q),{credentials:'same-origin',cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Recherche indisponible');
      const rows=Array.isArray(data.results)?data.results:[];
      results.innerHTML=rows.length?rows.map(row=>`<a class="mtd-search-result" href="${esc(row.href)}"><span class="mtd-search-result-icon">${iconMarkup(row.icon||'search')}</span><span><strong>${esc(row.label)}</strong><small>${esc(row.meta||'')}</small></span>${iconMarkup('chevron-right')}</a>`).join(''):'<div class="mtd-search-empty">Aucun résultat dans les données de production.</div>';
      results.classList.add('open');window.lucide?.createIcons();
    }catch(_){results.innerHTML='<div class="mtd-search-empty">Recherche temporairement indisponible.</div>'}
  }

  async function loadRequests(){
    const list=document.getElementById('mtd-shell-request-list');
    try{
      const response=await fetch('/api/admin/photo-deletion-requests',{credentials:'same-origin'});if(!response.ok)throw new Error();
      const pending=(await response.json()).filter(row=>row.status==='pending');
      const badge=document.getElementById('mtd-shell-badge');badge.hidden=!pending.length;badge.textContent=pending.length>99?'99+':pending.length;
      list.innerHTML=pending.length?pending.slice(0,8).map(row=>`<div class="mtd-shell-request"><span class="mtd-shell-request-icon">${iconMarkup('trash-2')}</span><span><strong>${esc((row.photo_type||'photo').toUpperCase())} — photo #${esc(row.photo_record_id)}</strong><small>Demandée par ${esc(row.requested_by_name||'Utilisateur')} · ${esc(date(row.requested_at))}</small></span></div>`).join(''):'<div class="mtd-shell-empty">Aucune demande en attente.</div>';
      window.lucide?.createIcons();
    }catch(_){list.innerHTML='<div class="mtd-shell-empty">Impossible de charger les demandes.</div>'}
  }

  function applySession(auth){
    if(!document.getElementById('mtd-dashboard-shell'))build();
    const user=auth||window.mtdSession||{},isAdmin=user.role==='admin';
    const name=document.getElementById('mtd-shell-name'),role=document.getElementById('mtd-shell-role');
    if(name)name.textContent=user.username||'Utilisateur';if(role)role.textContent=isAdmin?'Administrateur':user.role==='operator'?'Opérateur':user.role==='visitor'?'Visiteur':'Lecture seule';
    document.querySelectorAll('[data-mtd-admin-link]').forEach(el=>el.hidden=!isAdmin);
    const bell=document.getElementById('mtd-shell-bell');if(bell){bell.hidden=!isAdmin;if(isAdmin)loadRequests()}
  }

  const init=()=>{build();applySession(window.mtdSession);setTimeout(()=>{applySession(window.mtdSession);cleanLegacyIcons()},320)};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  window.addEventListener('mtd:session-ready',event=>applySession(event.detail));
})();
