(function(){
  'use strict';
  const page=((location.pathname||'').split('/').pop()||'admin.html').toLowerCase();
  if(page==='admin.html'||page==='login-admin.html'||document.getElementById('mtd-dashboard-shell'))return;
  const links=[
    ['admin.html','⌂','Tableau de bord'],
    ['admin-isolement.html','⚗','Isolement tissulaire'],
    ['admin-myc-liquide.html','▣','Mycélium liquide (LC)'],
    ['admin-myc-grain.html','✺','Mycélium sur grain'],
    ['admin-souches.html','✦','Souches'],
    ['admin-taches.html','✓','Tâches obligatoires'],
    ['admin-users.html','♟','Utilisateurs','admin']
  ];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=v=>v?new Date(v).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'}):'';
  function build(){
    if(document.getElementById('mtd-dashboard-shell'))return;
    document.body.classList.add('mtd-dashboard-shell');
    const overlay=document.createElement('div');overlay.className='mtd-shell-overlay';overlay.id='mtd-shell-overlay';
    const sidebar=document.createElement('aside');sidebar.className='mtd-shell-sidebar';sidebar.id='mtd-dashboard-shell';
    sidebar.innerHTML='<a class="mtd-shell-brand" href="admin.html"><img src="images/logo-agro.jpeg" alt="Logo"><span><strong>MYCELIUM</strong><small>TECH DIGITAL</small></span></a><nav class="mtd-shell-nav">'+links.map(([href,icon,label,role])=>'<a href="'+href+'"'+(page===href?' class="active"':'')+(role?' data-mtd-admin-link hidden':'')+'><i>'+icon+'</i>'+label+'</a>').join('')+'</nav><section class="mtd-shell-system"><small>État du système</small><strong>Opérationnel</strong><p>Données et photos protégées dans Supabase.</p></section><div class="mtd-shell-footer">Cultiver l’avenir, naturellement.<br><strong>Mycelium Tech Digital</strong></div>';
    const top=document.createElement('header');top.className='mtd-shell-topbar';
    top.innerHTML='<button class="mtd-shell-menu" type="button" aria-label="Ouvrir le menu">☰</button><label class="mtd-shell-search"><span>⌕</span><input type="search" placeholder="Rechercher une boîte, souche, matrice…" aria-label="Rechercher"></label><span class="mtd-shell-spacer"></span><button class="mtd-shell-icon" type="button" title="Apparence">☼</button><button class="mtd-shell-icon" id="mtd-shell-bell" type="button" title="Demandes de suppression" aria-label="Demandes de suppression" hidden>🔔<span class="mtd-shell-badge" id="mtd-shell-badge" hidden>0</span></button><div class="mtd-shell-profile"><img src="images/logo-agro.jpeg" alt=""><span><strong id="mtd-shell-name">Utilisateur</strong><small id="mtd-shell-role">Connexion…</small></span></div><button class="mtd-shell-logout" type="button" title="Déconnexion" aria-label="Déconnexion">⌄</button>';
    const notifications=document.createElement('section');notifications.className='mtd-shell-notifications';notifications.id='mtd-shell-notifications';notifications.innerHTML='<h3>Demandes de suppression</h3><div id="mtd-shell-request-list"><div class="mtd-shell-empty">Chargement…</div></div><a href="admin-users.html" class="mtd-shell-review">Gérer les demandes →</a>';
    document.body.prepend(overlay,sidebar,top,notifications);
    top.querySelector('.mtd-shell-menu').addEventListener('click',()=>{sidebar.classList.toggle('open');overlay.classList.toggle('open')});
    overlay.addEventListener('click',()=>{sidebar.classList.remove('open');overlay.classList.remove('open')});
    top.querySelector('.mtd-shell-logout').addEventListener('click',()=>window.logoutAdmin&&window.logoutAdmin());
    top.querySelector('#mtd-shell-bell').addEventListener('click',()=>notifications.classList.toggle('open'));
    document.addEventListener('click',event=>{if(!notifications.contains(event.target)&&event.target!==top.querySelector('#mtd-shell-bell'))notifications.classList.remove('open')});
  }
  async function loadRequests(){
    const list=document.getElementById('mtd-shell-request-list');
    try{
      const response=await fetch('/api/admin/photo-deletion-requests',{credentials:'same-origin'});
      if(!response.ok)throw new Error('Requests unavailable');
      const pending=(await response.json()).filter(row=>row.status==='pending');
      const badge=document.getElementById('mtd-shell-badge');badge.hidden=!pending.length;badge.textContent=pending.length>99?'99+':pending.length;
      list.innerHTML=pending.length?pending.slice(0,8).map(row=>'<div class="mtd-shell-request"><span class="mtd-shell-request-icon">🗑</span><span><strong>'+esc((row.photo_type||'photo').toUpperCase())+' — photo #'+esc(row.photo_record_id)+'</strong><small>Demandée par '+esc(row.requested_by_name||'Utilisateur')+' · '+esc(date(row.requested_at))+'</small></span></div>').join(''):'<div class="mtd-shell-empty">Aucune demande en attente.</div>';
    }catch(_){list.innerHTML='<div class="mtd-shell-empty">Impossible de charger les demandes.</div>'}
  }
  function applySession(auth){
    if(!document.getElementById('mtd-dashboard-shell'))build();
    const user=auth||window.mtdSession||{},isAdmin=user.role==='admin';
    document.getElementById('mtd-shell-name').textContent=user.username||'Utilisateur';
    document.getElementById('mtd-shell-role').textContent=isAdmin?'Administrateur':user.role==='operator'?'Opérateur':'Lecture seule';
    document.querySelectorAll('[data-mtd-admin-link]').forEach(el=>el.hidden=!isAdmin);
    const bell=document.getElementById('mtd-shell-bell');bell.hidden=!isAdmin;if(isAdmin)loadRequests();
  }
  document.addEventListener('DOMContentLoaded',()=>{build();applySession(window.mtdSession);setTimeout(()=>applySession(window.mtdSession),300)});
  window.addEventListener('mtd:session-ready',event=>applySession(event.detail));
})();
