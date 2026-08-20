/* Mycelium Tech Digital - sessions Admin + Visiteur Smart Capital */
(function () {
  "use strict";

  const UI_KEY = "myceliumtech_admin_ui";
  const SESSION_UI_KEY = "myceliumtech_session_ui";
  const LEGACY_KEYS = ["basly_admin_auth", "admin_auth", "adminAuth", "baslyagro_admin", "basly_admin"];

  const PAGE_GUIDES = {
    "admin.html": {
      title: "Tableau de bord",
      text: "Cette page donne une vue synthétique de l'activité du laboratoire et permet d'accéder rapidement aux principaux modules de traçabilité.",
      action: "Pendant la démonstration, utilisez-la comme point de départ pour parcourir un cycle complet."
    },
    "admin-taches.html": {
      title: "Tâches obligatoires",
      text: "Cette page centralise uniquement les contrôles et opérations qui demandent une action aujourd'hui ou qui sont en retard. Elle ne sert pas au suivi des objectifs de production.",
      action: "Ouvrez une tâche pour arriver directement dans le journal de la souche, de la boîte, du pot LC ou du pot/sac grain concerné."
    },
    "admin-souches.html": {
      title: "Souches",
      text: "La bibliothèque de souches constitue la base de la traçabilité biologique : origine, identification, conservation, statut et disponibilité pour les productions suivantes.",
      action: "Vous pouvez tester les formulaires et les changements de statut : ils resteront temporaires en mode visiteur."
    },
    "admin-souche-journal.html": {
      title: "Journal de souche",
      text: "Ce journal documente l'historique et les manipulations associées à une souche afin de conserver une continuité entre la source biologique et les productions qui en découlent.",
      action: "Les essais réalisés ici sont visibles pendant la session de démonstration uniquement."
    },
    "admin-isolement.html": {
      title: "Isolation tissulaire",
      text: "Ce module suit l'isolement et les repiquages sur boîtes de Pétri, notamment les phases P1, P2 et P3, avec identification et traçabilité de chaque boîte.",
      action: "Sélectionnez une boîte pour consulter son état puis ouvrez son journal quotidien."
    },
    "admin-isolement-journal.html": {
      title: "Journal d'isolation tissulaire",
      text: "Le journal enregistre les observations quotidiennes, les contrôles visuels, les photos et les décisions prises pendant l'évolution d'une boîte de Pétri.",
      action: "Traiter un jour ici permet de montrer comment une tâche obligatoire disparaît une fois l'opération renseignée."
    },
    "admin-myc-liquide.html": {
      title: "Mycélium liquide",
      text: "Ce module organise les lots de mycélium liquide, leurs pots, leur source biologique et leur passage dans le cycle d'incubation contrôlé.",
      action: "Vous pouvez créer ou manipuler un lot de démonstration sans modifier les données permanentes."
    },
    "admin-lc-cycle.html": {
      title: "Journal mycélium liquide",
      text: "Cette page suit chaque pot LC jour par jour : agitation, température, croissance, contamination, photos de référence et validation qualité.",
      action: "Les saisies du visiteur restent disponibles pendant la session puis sont annulées automatiquement."
    },
    "admin-myc-grain.html": {
      title: "Mycélium sur grain",
      text: "Cette étape gère la préparation stérile du grain, l'ensemencement à partir d'une LC validée et la traçabilité des pots ou sacs produits.",
      action: "Testez la préparation et l'ensemencement comme en exploitation réelle : aucune écriture visiteur ne sera conservée."
    },
    "admin-myc-grain-journal.html": {
      title: "Journal mycélium sur grain",
      text: "Le journal mesure l'évolution de la colonisation de chaque pot ou sac, avec propagation, contrôles de contamination, température, photos et conclusion.",
      action: "Une saisie de démonstration est immédiatement visible dans la session, mais disparaît à sa fermeture."
    }
  };

  function currentPage() {
    return ((location.pathname || "").split("/").pop() || "").toLowerCase();
  }

  function normalizeAuth(obj) {
    if (!obj || !obj.username) return null;
    return {
      username: String(obj.username || obj.user || obj.login || "Admin"),
      role: ["admin", "operator", "viewer", "visitor"].includes(String(obj.role)) ? String(obj.role) : "operator",
      must_change_password: !!obj.must_change_password,
      loginAt: obj.loginAt || obj.login_at || new Date().toISOString()
    };
  }

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function readUiAuth() {
    const sessionAuth = normalizeAuth(readJson(sessionStorage, SESSION_UI_KEY));
    if (sessionAuth) return sessionAuth;

    const localAuth = normalizeAuth(readJson(localStorage, UI_KEY));
    if (localAuth) return localAuth;

    // Compatibilité avec l'ancien système navigateur.
    try {
      if (sessionStorage.getItem("isAdminLoggedIn") === "true") {
        return {
          username: sessionStorage.getItem("adminUsername") || "Admin",
          role: "admin",
          loginAt: sessionStorage.getItem("adminLoginAt") || new Date().toISOString()
        };
      }
    } catch (_) {}

    for (const key of LEGACY_KEYS) {
      const obj = normalizeAuth(readJson(localStorage, key));
      if (obj) return obj;
    }
    return null;
  }

  function saveUiAuth(user) {
    const auth = {
      username: (user && (user.username || user.user || user.login)) || "Admin",
      role: user && ["admin", "operator", "viewer", "visitor"].includes(String(user.role)) ? String(user.role) : "operator",
      must_change_password: !!(user && user.must_change_password),
      loginAt: new Date().toISOString()
    };

    try { sessionStorage.setItem(SESSION_UI_KEY, JSON.stringify(auth)); } catch (_) {}

    // Le visiteur reste volontairement lié à l'onglet/session du navigateur.
    try {
      if (auth.role === "visitor") localStorage.removeItem(UI_KEY);
      else localStorage.setItem(UI_KEY, JSON.stringify(auth));
    } catch (_) {}

    try {
      sessionStorage.setItem("isAdminLoggedIn", "true");
      sessionStorage.setItem("adminUsername", auth.username);
      sessionStorage.setItem("adminLoginAt", auth.loginAt);
    } catch (_) {}
    return auth;
  }

  function clearUiAuth() {
    try {
      localStorage.removeItem(UI_KEY);
      sessionStorage.removeItem(SESSION_UI_KEY);
    } catch (_) {}
    for (const key of LEGACY_KEYS) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
    try {
      sessionStorage.removeItem("isAdminLoggedIn");
      sessionStorage.removeItem("adminUsername");
      sessionStorage.removeItem("adminLoginAt");
      sessionStorage.removeItem("adminRedirectAfterLogin");
    } catch (_) {}
  }

  function loginUrl() {
    const page = currentPage();
    const next = encodeURIComponent(page + (location.search || ""));
    return "login-admin.html?next=" + next;
  }

  function ensureSessionStyles() {
    if (document.getElementById("mtd-session-style")) return;
    const style = document.createElement("style");
    style.id = "mtd-session-style";
    style.textContent = `
      #mtd-session-strip{position:relative;z-index:9998;display:flex;align-items:center;gap:12px;padding:9px 18px;background:#173f2a;color:#fff;font:600 12px/1.3 Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.16)}
      #mtd-session-strip.mtd-visitor{background:#73510d}
      #mtd-session-strip .mtd-session-home{color:#fff;text-decoration:none;font-weight:800}
      #mtd-session-strip .mtd-session-spacer{flex:1}
      #mtd-session-strip .mtd-role-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.45);border-radius:999px;padding:5px 9px;background:rgba(255,255,255,.1)}
      #mtd-session-strip button{border:1px solid rgba(255,255,255,.55);background:transparent;color:#fff;border-radius:999px;padding:6px 11px;font-weight:700;cursor:pointer}
      .mtd-visitor-guide-wrap{padding:0 15px;margin:18px auto 4px;max-width:1200px}
      .mtd-visitor-guide{background:#fff;border:1px solid #dfe9e2;border-left:5px solid #2fa35a;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:16px 18px;color:#26352b;font-family:Montserrat,Arial,sans-serif}
      .mtd-visitor-guide-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:7px}
      .mtd-visitor-guide-title{font-weight:800;font-size:15px;color:#1f7a41}
      .mtd-demo-pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#fff0cf;color:#795400;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .mtd-visitor-guide p{margin:0 0 5px;font-size:12.5px;line-height:1.55;color:#4e5c52}
      .mtd-demo-rule{margin-top:10px;padding:9px 11px;border-radius:9px;background:#f7fbf8;border:1px dashed #9cccad;font-size:11.5px;color:#36543f}
      @media(max-width:650px){#mtd-session-strip{flex-wrap:wrap}.mtd-session-user{order:3;width:100%}.mtd-visitor-guide-wrap{margin-top:12px}}
    `;
    document.head.appendChild(style);
  }

  function injectSessionStrip() {
    if (currentPage() === "login-admin.html") return null;
    ensureSessionStyles();
    let bar = document.getElementById("mtd-session-strip");
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = "mtd-session-strip";
    bar.innerHTML = '<a href="admin.html" class="mtd-session-home">Mycelium Tech Digital</a>' +
      '<span class="mtd-role-pill" id="mtd-role-pill">Admin</span>' +
      '<span class="mtd-session-spacer"></span>' +
      '<span class="mtd-session-user">Connecté : <strong id="mtd-session-user-name"></strong></span>' +
      '<button type="button" id="mtd-session-logout">Déconnexion</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById("mtd-session-logout").addEventListener("click", window.logoutAdmin);
    return bar;
  }

  function removeVisitorGuide() {
    const old = document.getElementById("mtd-visitor-guide-wrap");
    if (old) old.remove();
  }

  function injectVisitorGuide(auth) {
    removeVisitorGuide();
    if (!auth || auth.role !== "visitor" || currentPage() === "login-admin.html") return;
    ensureSessionStyles();

    const guide = PAGE_GUIDES[currentPage()] || {
      title: "Mode démonstration",
      text: "Cette page fait partie de l'environnement de traçabilité Mycelium Tech Digital.",
      action: "Vous pouvez tester les fonctions sans modifier les données permanentes."
    };

    const wrap = document.createElement("div");
    wrap.id = "mtd-visitor-guide-wrap";
    wrap.className = "mtd-visitor-guide-wrap";
    wrap.innerHTML = `<div class="mtd-visitor-guide">
      <div class="mtd-visitor-guide-head">
        <span class="mtd-demo-pill">Démonstration Smart Capital</span>
        <span class="mtd-visitor-guide-title">ⓘ ${guide.title}</span>
      </div>
      <p>${guide.text}</p>
      <p><strong>À tester :</strong> ${guide.action}</p>
      <div class="mtd-demo-rule"><strong>Mode visiteur éphémère :</strong> les ajouts, modifications, suppressions et validations fonctionnent dans cette session de démonstration, mais aucune modification n'est conservée après la déconnexion ou l'expiration de la session.</div>
    </div>`;

    const menu = document.querySelector(".admin-menu-bar");
    if (menu && menu.parentNode) menu.insertAdjacentElement("afterend", wrap);
    else {
      const strip = document.getElementById("mtd-session-strip");
      if (strip && strip.parentNode) strip.insertAdjacentElement("afterend", wrap);
      else document.body.insertBefore(wrap, document.body.firstChild);
    }
  }

  function renderSessionChrome(auth) {
    if (currentPage() === "login-admin.html") return;
    auth = normalizeAuth(auth) || readUiAuth() || { username: "Admin", role: "admin", loginAt: null };
    const bar = injectSessionStrip();
    const isVisitor = auth.role === "visitor";

    if (bar) bar.classList.toggle("mtd-visitor", isVisitor);
    const name = document.getElementById("mtd-session-user-name");
    if (name) name.textContent = auth.username || (isVisitor ? "Visiteur" : "Admin");
    const role = document.getElementById("mtd-role-pill");
    if (role) role.textContent = isVisitor ? "👁 Visiteur · Démo" : auth.role === "admin" ? "🔐 Administrateur" : auth.role === "operator" ? "🧪 Opérateur" : "👁 Lecture seule";

    document.querySelectorAll('.mtd-users-admin-link').forEach(el=>el.remove());
    const menu=document.querySelector('.admin-menu-bar');
    if(auth.role==='admin'&&menu){
      const link=document.createElement('a');
      link.href='admin-users.html';
      link.className='mtd-users-admin-link'+(currentPage()==='admin-users.html'?' active':'');
      link.textContent='Utilisateurs';
      menu.appendChild(link);
    }
    document.querySelectorAll('[data-admin-only]').forEach(el=>{ el.style.display=auth.role==='admin'?'':'none'; });
    if(currentPage()==='admin-users.html'&&auth.role!=='admin')location.replace('admin.html');

    document.documentElement.classList.toggle("mtd-visitor-mode", isVisitor);
    if (document.body) document.body.classList.toggle("mtd-visitor-mode", isVisitor);
    injectVisitorGuide(auth);
    window.mtdSession = auth;
    window.dispatchEvent(new CustomEvent("mtd:session-ready", { detail: auth }));
  }

  async function verifyServerSession() {
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("Session inactive");
      const data = await res.json();
      if (!data || !data.authenticated) throw new Error("Session inactive");
      const auth = saveUiAuth(data.user || { username: "Admin", role: "admin" });
      if (auth.must_change_password && currentPage() !== "change-password.html") {
        location.replace("change-password.html");
        return auth;
      }
      if (document.readyState !== "loading") renderSessionChrome(auth);
      return auth;
    } catch (_) {
      clearUiAuth();
      if (currentPage() !== "login-admin.html") location.replace(loginUrl());
      return null;
    }
  }

  window.startAdminSession = function startAdminSession(user) {
    const auth = saveUiAuth(user);
    if (document.readyState !== "loading") renderSessionChrome(auth);
    return auth;
  };

  window.requireAdminAuth = function requireAdminAuth() {
    if (currentPage() === "login-admin.html") return null;
    const auth = readUiAuth();
    verifyServerSession();
    return auth || { username: "Utilisateur", role: "admin" };
  };

  let heartbeatTimer=null;
  function startHeartbeat(auth){
    if(!auth||auth.role==='visitor'||heartbeatTimer)return;
    const beat=()=>{if(document.visibilityState==='visible')fetch('/api/auth/heartbeat',{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{});};
    beat();
    heartbeatTimer=setInterval(beat,10*60*1000);
  }

  window.isVisitorMode = function isVisitorMode() {
    const auth = readUiAuth();
    return !!(auth && auth.role === "visitor");
  };

  window.redirectIfLoggedIn = async function redirectIfLoggedIn(nextUrl) {
    if (currentPage() !== "login-admin.html") return;
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.authenticated) return;
      saveUiAuth(data.user || { username: "Admin", role: "admin" });
      const params = new URLSearchParams(location.search || "");
      location.replace(params.get("next") || nextUrl || "admin.html");
    } catch (_) {}
  };

  window.logoutAdmin = function logoutAdmin() {
    clearUiAuth();
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true
    }).catch(() => {}).finally(() => location.replace("login-admin.html"));
  };

  window.renderAdminSessionUI = function renderAdminSessionUI(opts) {
    const auth = readUiAuth() || { username: "Admin", role: "admin" };
    const cfg = opts || {};
    const userTarget = document.getElementById(cfg.usernameTargetId || "admin-username");
    if (userTarget) userTarget.textContent = auth.username || "Admin";
    const loginTime = document.getElementById("admin-login-time");
    if (loginTime && auth.loginAt) {
      try { loginTime.textContent = " · " + new Date(auth.loginAt).toLocaleString(); } catch (_) {}
    }
    const logoutBtn = document.getElementById(cfg.logoutBtnId || "admin-logout-btn");
    if (logoutBtn && !logoutBtn.dataset.authBound) {
      logoutBtn.dataset.authBound = "1";
      logoutBtn.addEventListener("click", window.logoutAdmin);
    }
    renderSessionChrome(auth);
    return auth;
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (currentPage() !== "login-admin.html") {
      renderSessionChrome(readUiAuth());
      verifyServerSession().then(startHeartbeat);
    }
  });
})();
