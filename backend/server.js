// server.js (COMPLET CORRIGÉ) – Mycelium Tech Digital backend
require("dotenv").config();

let path = require("path");
let fs = require("fs");
let express = require("express");
let cors = require("cors");
let multer = require("multer");
let crypto = require("crypto");
let sharp = require("sharp");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { AsyncLocalStorage } = require("async_hooks");
const { Pool } = require("pg");
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const {
  deleteDemoSupabaseFiles,
  deleteStoredFile,
  getSupabaseAdmin,
  isVercelRuntime,
  parseSupabasePublicObjectUrl,
  persistUploadedFile,
  safeExtension,
  shouldUseCloudStorage,
} = require("./supabase-storage");

// ✅ NOUVEAU : Import des routes souches
let strainsRoutes = require("./routes/strains");
let cyclesRoutes = require("./routes/cycles");

let app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

let PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = isVercelRuntime();
const USE_CLOUD_STORAGE = shouldUseCloudStorage();
const MAX_UPLOAD_BYTES = IS_VERCEL ? 4 * 1024 * 1024 : 6 * 1024 * 1024;

// Admin-only frontend (parent folder of backend)
let SITE_DIR = path.join(__dirname, "..");
let STATIC_DIR = path.join(SITE_DIR, "public");

// ============================================================
// AUTHENTIFICATION ADMIN - session signee HttpOnly
// ============================================================
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "BaslyAli");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const VISITOR_USERNAME = String(process.env.VISITOR_USERNAME || "Visiteur Smart Capital");
const VISITOR_ACCESS_CODE = String(process.env.VISITOR_ACCESS_CODE || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const SESSION_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 8));
const VISITOR_SESSION_HOURS = Math.max(1, Number(process.env.VISITOR_SESSION_HOURS || 2));
const SESSION_COOKIE = "mtd_admin_session";

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function signPayload(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSupabaseLoginClient() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Supabase Auth non configuré');
  return createSupabaseClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false } });
}

function createSessionToken({ username, role = "admin", userId = null, hours = SESSION_HOURS }) {
  const payload = Buffer.from(JSON.stringify({
    username,
    role,
    userId,
    sid: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + Math.max(1, Number(hours || SESSION_HOURS)) * 60 * 60 * 1000
  }), "utf8").toString("base64url");
  return payload + "." + signPayload(payload);
}

function readSession(req) {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const expected = Buffer.from(signPayload(parts[0]));
    const actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!data || !data.username || !data.exp || Date.now() >= Number(data.exp)) return null;
    data.role = String(data.role || "operator");
    if (!data.sid) data.sid = crypto.createHash("sha256").update(parts[0]).digest("hex").slice(0, 32);
    return data;
  } catch (_) {
    return null;
  }
}

function setSessionCookie(req, res, { username, role = "admin", userId = null }) {
  const hours = role === "visitor" ? VISITOR_SESSION_HOURS : SESSION_HOURS;
  const token = createSessionToken({ username, role, userId, hours });
  const secure = process.env.NODE_ENV === "production" || req.secure || req.headers["x-forwarded-proto"] === "https";
  const maxAgePart = role === "visitor" ? "" : `; Max-Age=${hours * 60 * 60}`;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${maxAgePart}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(req, res) {
  const secure = process.env.NODE_ENV === "production" || req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}

async function requireAdminSession(req, res, next) {
  const session = readSession(req);
  if (!session) {
    if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
      return res.status(401).json({ authenticated: false, error: "Session requise" });
    }
    const nextUrl = encodeURIComponent(req.originalUrl || "/admin.html");
    return res.redirect(`/login-admin.html?next=${nextUrl}`);
  }
  try {
    if (session.role !== "visitor" && session.userId) {
      await ensureUserManagementSchema();
      const access = await loadApplicationUser(session.userId);
      if (!access || !access.active) {
        clearSessionCookie(req, res);
        return res.status(403).json({ authenticated: false, error: "Compte utilisateur gelé ou supprimé" });
      }
      session.username = access.username;
      session.role = access.role;
      session.must_change_password = access.must_change_password;
      session.permissions = access.permissions;
    } else if (session.role !== "visitor") {
      session.role = "admin"; // compte de récupération BaslyAli via variables Vercel
      session.permissions = ["*"];
    }
    req.adminSession = session;
    next();
  } catch (e) {
    console.error("Chargement droits utilisateur:", e);
    return res.status(503).json({ authenticated: false, error: "Droits utilisateur indisponibles" });
  }
}

app.post("/api/auth/login", async (req, res) => {
  if (!SESSION_SECRET) return res.status(503).json({ authenticated: false, error: "SESSION_SECRET est requis." });
  const username = String((req.body && req.body.username) || "").trim();
  const password = String((req.body && req.body.password) || "");
  if (ADMIN_PASSWORD && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    setSessionCookie(req, res, { username, role: "admin" });
    return res.json({ authenticated: true, user: { username, role: "admin", must_change_password: false } });
  }
  try {
    await ensureUserManagementSchema();
    let email = username;
    if (!username.includes("@")) {
      const lookup = await realPool.query(`SELECT email FROM app_users WHERE lower(username)=lower($1) LIMIT 1`, [username]);
      email = String(lookup.rows[0]?.email || "");
    }
    if (!email) return res.status(401).json({ authenticated: false, error: "Identifiants incorrects" });
    const supabase = createSupabaseLoginClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.user) return res.status(401).json({ authenticated: false, error: "Identifiants incorrects" });
    const access = await loadApplicationUser(data.user.id);
    if (!access || !access.active) return res.status(403).json({ authenticated: false, error: "Compte gelé ou non autorisé" });
    setSessionCookie(req, res, { username: access.username, role: access.role, userId: data.user.id });
    return res.json({ authenticated: true, user: access });
  } catch (e) {
    console.error("Connexion Supabase:", e);
    return res.status(401).json({ authenticated: false, error: "Identifiants incorrects" });
  }
});

app.post("/api/auth/visitor", (req, res) => {
  if (!VISITOR_ACCESS_CODE || !SESSION_SECRET) {
    return res.status(503).json({ authenticated: false, error: "Mode visiteur non configure sur Vercel." });
  }
  const accessCode = String((req.body && req.body.access_code) || "");
  if (!VISITOR_ACCESS_CODE || accessCode !== VISITOR_ACCESS_CODE) {
    return res.status(401).json({ authenticated: false, error: "Code de démonstration incorrect" });
  }
  setSessionCookie(req, res, { username: VISITOR_USERNAME, role: "visitor" });
  return res.json({
    authenticated: true,
    user: { username: VISITOR_USERNAME, role: "visitor" },
    demo: true,
    ephemeral: true
  });
});

app.get("/api/auth/session", requireAdminSession, (req, res) => {
  const session = req.adminSession;
  return res.json({
    authenticated: true,
    user: { username: session.username, role: session.role || "operator", must_change_password: !!session.must_change_password },
    demo: session.role === "visitor",
    ephemeral: session.role === "visitor",
    expiresAt: session.exp
  });
});

app.post("/api/auth/change-password", requireAdminSession, async (req, res) => {
  try {
    const session = req.adminSession;
    if (!session.userId) return res.status(400).json({ error: "Le compte de récupération utilise les variables Vercel." });
    const password = String(req.body?.password || "");
    if (password.length < 10) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 10 caractères." });
    const { error } = await getSupabaseAdmin().auth.admin.updateUserById(session.userId, { password });
    if (error) throw error;
    await realPool.query(`UPDATE app_users SET must_change_password=FALSE, updated_at=now() WHERE auth_user_id=$1`, [session.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/logout", async (req, res) => {
  const session = readSession(req);
  clearSessionCookie(req, res);
  if (session && session.role === "visitor" && session.sid) {
    try { await closeDemoSession(session.sid); }
    catch (err) { console.error("Demo rollback logout:", err.message); }
  }
  return res.json({ ok: true });
});

// Protect every admin page and uploaded laboratory media.
app.use((req, res, next) => {
  const isAdminHtml = /^\/admin(?:-[^/]+)?\.html$/i.test(req.path);
  const isUpload = req.path === "/uploads" || req.path.startsWith("/uploads/");
  if (isAdminHtml || isUpload) return requireAdminSession(req, res, () => {
    if (req.path.toLowerCase() === '/admin-users.html' && req.adminSession?.role !== 'admin') return res.redirect('/admin.html');
    next();
  });
  next();
});

// All business APIs require a valid admin session. Auth endpoints above remain public.
app.use("/api", requireAdminSession);
app.use("/api", (req, res, next) => {
  if (req.adminSession?.role === 'viewer' && !['GET','HEAD','OPTIONS'].includes(req.method) && req.path !== '/auth/heartbeat') {
    return res.status(403).json({ error: 'Ce rôle est limité à la lecture.' });
  }
  if (req.adminSession?.role === 'operator' && req.method === 'DELETE') {
    const isPhotoRequest = /^\/album-photos\/\d+$/.test(req.path) ||
      /^\/lc-workflow\/lots\/\d+\/journal\/\d+\/photo$/.test(req.path) ||
      /^\/grain-units\/\d+\/journal\/\d+\/photo$/.test(req.path);
    if (!isPhotoRequest) return res.status(403).json({ error: 'Un opérateur ne peut pas supprimer directement cet élément.' });
  }
  next();
});

app.use("/backend", (req, res) => res.status(404).end());
// Vercel sert les fichiers statiques depuis public/. En local, on garde le serveur historique.
if (!IS_VERCEL) app.use(express.static(STATIC_DIR, { dotfiles: "deny", index: false }));

// Dossiers locaux uniquement. En production Vercel, les fichiers sont envoyes vers Supabase Storage.
let UPLOAD_DIR = path.join(SITE_DIR, "uploads", "isolements");
let LC_UPLOAD_DIR = path.join(SITE_DIR, "uploads", "lc");
let GRAIN_UPLOAD_DIR = path.join(SITE_DIR, "uploads", "grain");
if (!USE_CLOUD_STORAGE) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(LC_UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(GRAIN_UPLOAD_DIR, { recursive: true });
  app.use("/uploads", express.static(path.join(SITE_DIR, "uploads")));
}

// Connexion PostgreSQL : DATABASE_URL est recommandee sur Vercel (Neon, Supabase, Railway, etc.).
const poolOptions = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Number(process.env.PGPOOL_MAX || 5)),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || "baslyagro",
      user: process.env.DB_USER || "postgres",
      password: String(process.env.DB_PASSWORD || ""),
      max: Math.max(1, Number(process.env.PGPOOL_MAX || 5)),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
let realPool = new Pool(poolOptions);

let userManagementSchemaReady = false;
async function ensureUserManagementSchema() {
  if (userManagementSchemaReady) return;
  await realPool.query(`
    CREATE TABLE IF NOT EXISTS app_roles (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_permissions (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS app_role_permissions (
      role_id BIGINT NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
      permission_id BIGINT NOT NULL REFERENCES app_permissions(id) ON DELETE CASCADE,
      PRIMARY KEY(role_id, permission_id)
    );
    CREATE TABLE IF NOT EXISTS app_users (
      auth_user_id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      role_id BIGINT NOT NULL REFERENCES app_roles(id),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS photo_deletion_requests (
      id BIGSERIAL PRIMARY KEY,
      photo_type TEXT NOT NULL CHECK (photo_type IN ('petri','lc','grain')),
      photo_record_id BIGINT NOT NULL,
      photo_url TEXT NOT NULL,
      context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      requested_by UUID,
      requested_by_name TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by UUID,
      reviewed_by_name TEXT,
      reviewed_at TIMESTAMPTZ,
      review_note TEXT
    );
    CREATE TABLE IF NOT EXISTS production_activity_log (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id UUID,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      module TEXT NOT NULL CHECK (module IN ('petri','lc','grain')),
      action_type TEXT NOT NULL CHECK (action_type IN ('added','modified','photo_added','delete_requested','photo_deleted','delete_approved','delete_rejected')),
      item_id BIGINT NOT NULL,
      item_label TEXT NOT NULL,
      day_index INTEGER,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_photo_deletion_pending
      ON photo_deletion_requests(photo_type, photo_record_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS ix_production_activity_created_at ON production_activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_production_activity_actor_month ON production_activity_log(actor_user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_production_activity_item ON production_activity_log(module,item_id,created_at DESC);
  `);
  // Upgrade the earlier RBAC draft, which used app_users.user_id and fewer columns.
  await realPool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name='user_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name='auth_user_id') THEN
        ALTER TABLE app_users RENAME COLUMN user_id TO auth_user_id;
      END IF;
    END $$;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS context_data JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS reason TEXT;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS requested_by_name TEXT;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS reviewed_by UUID;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    ALTER TABLE photo_deletion_requests ADD COLUMN IF NOT EXISTS review_note TEXT;
    UPDATE photo_deletion_requests SET requested_by_name='Utilisateur' WHERE requested_by_name IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_app_users_email ON app_users(lower(email)) WHERE email IS NOT NULL;
  `);
  // When DATABASE_URL points at Supabase, recover emails for rows made with the old SQL.
  await realPool.query(`
    DO $$ BEGIN
      IF to_regclass('auth.users') IS NOT NULL THEN
        UPDATE app_users u SET email=a.email, updated_at=now()
        FROM auth.users a WHERE a.id=u.auth_user_id AND (u.email IS NULL OR u.email='');
      END IF;
    END $$;
  `);
  const roles = [['admin','Administrateur'],['operator','Opérateur'],['viewer','Lecture seule']];
  for (const [code, name] of roles) await realPool.query(`INSERT INTO app_roles(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`, [code, name]);
  const permissions = [
    ['users.manage','Gérer les utilisateurs'],['photo.upload','Ajouter des photos'],
    ['photo.edit','Modifier des photos'],['photo.delete.request','Demander une suppression'],
    ['photo.delete.direct','Supprimer immédiatement'],['photo.delete.approve','Approuver les suppressions']
  ];
  for (const [code, description] of permissions) await realPool.query(`INSERT INTO app_permissions(code,description) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description`, [code, description]);
  await realPool.query(`
    INSERT INTO app_role_permissions(role_id,permission_id)
    SELECT r.id,p.id FROM app_roles r CROSS JOIN app_permissions p WHERE r.code='admin'
    ON CONFLICT DO NOTHING;
    INSERT INTO app_role_permissions(role_id,permission_id)
    SELECT r.id,p.id FROM app_roles r JOIN app_permissions p ON p.code IN ('photo.upload','photo.edit','photo.delete.request') WHERE r.code='operator'
    ON CONFLICT DO NOTHING;
  `);
  userManagementSchemaReady = true;
}

async function loadApplicationUser(userId) {
  const result = await realPool.query(`
    SELECT u.auth_user_id AS "userId", u.email, u.username, u.display_name, u.active,
           u.must_change_password, u.last_seen_at, r.code AS role,
           COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), ARRAY[]::text[]) AS permissions
    FROM app_users u JOIN app_roles r ON r.id=u.role_id
    LEFT JOIN app_role_permissions rp ON rp.role_id=r.id
    LEFT JOIN app_permissions p ON p.id=rp.permission_id
    WHERE u.auth_user_id=$1
    GROUP BY u.auth_user_id,r.code
  `, [userId]);
  return result.rows[0] || null;
}

function hasPermission(req, permission) {
  const session = req.adminSession || {};
  return session.role === 'admin' || (Array.isArray(session.permissions) && (session.permissions.includes('*') || session.permissions.includes(permission)));
}

function requirePermission(permission) {
  return (req, res, next) => hasPermission(req, permission) ? next() : res.status(403).json({ error: 'Permission refusée' });
}

async function recordProductionActivity(req, activity) {
  const session = req.adminSession || {};
  if (!session.username || session.role === 'visitor') return;
  try {
    await ensureUserManagementSchema();
    await realPool.query(`
      INSERT INTO production_activity_log
        (actor_user_id,actor_name,actor_role,module,action_type,item_id,item_label,day_index,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [
      session.userId || null,
      session.username,
      session.role || 'operator',
      activity.module,
      activity.actionType,
      Number(activity.itemId),
      String(activity.itemLabel || activity.itemId),
      activity.dayIndex !== null && activity.dayIndex !== undefined && Number.isFinite(Number(activity.dayIndex)) ? Number(activity.dayIndex) : null,
      JSON.stringify(activity.details || {})
    ]);
  } catch (error) {
    // An audit write must never make the production journal action fail.
    console.error('Production activity audit:', error.message);
  }
}

function deletionReviewActivity(requestRow, actionType) {
  const context = requestRow?.context_data && typeof requestRow.context_data === 'object' ? requestRow.context_data : {};
  const moduleName = String(requestRow?.photo_type || 'petri');
  const contextualId = moduleName === 'petri' ? context.petriId : moduleName === 'lc' ? context.potId : context.unitId;
  const itemId = Number(contextualId || requestRow?.photo_record_id);
  return {
    module: moduleName,
    actionType,
    itemId,
    itemLabel: context.itemLabel || (contextualId ? (moduleName === 'petri' ? `Petri ID ${contextualId}` : moduleName === 'lc' ? `LC pot ID ${contextualId}` : `Grain unité ID ${contextualId}`) : `Photo ${moduleName.toUpperCase()} #${requestRow?.photo_record_id}`),
    dayIndex: context.dayIndex,
    details: {
      request_id: Number(requestRow?.id),
      photo_record_id: Number(requestRow?.photo_record_id),
      requested_by: requestRow?.requested_by_name || null
    }
  };
}

async function queuePhotoDeletion(req, res, photoType, photoRecordId, photoUrl, contextData = {}) {
  if (hasPermission(req, 'photo.delete.direct')) return false;
  if (!hasPermission(req, 'photo.delete.request')) {
    res.status(403).json({ error: 'Vous ne pouvez pas supprimer ni demander la suppression de cette photo.' });
    return true;
  }
  await ensureUserManagementSchema();
  const result = await realPool.query(`
    INSERT INTO photo_deletion_requests(photo_type,photo_record_id,photo_url,context_data,requested_by,requested_by_name)
    VALUES($1,$2,$3,$4::jsonb,$5,$6)
    ON CONFLICT (photo_type,photo_record_id) WHERE status='pending'
    DO UPDATE SET reason=COALESCE(photo_deletion_requests.reason,EXCLUDED.reason)
    RETURNING id,status,(xmax=0) AS created
  `, [photoType,photoRecordId,photoUrl,JSON.stringify(contextData),req.adminSession?.userId || null,req.adminSession?.username || 'Utilisateur']);
  const itemId = photoType === 'petri' ? contextData.petriId : photoType === 'lc' ? contextData.potId : contextData.unitId;
  if (itemId && result.rows[0].created) await recordProductionActivity(req, {
    module: photoType,
    actionType: 'delete_requested',
    itemId,
    itemLabel: contextData.itemLabel || (photoType === 'petri' ? `Petri ID ${itemId}` : photoType === 'lc' ? `LC pot ID ${itemId}` : `Grain unité ID ${itemId}`),
    dayIndex: contextData.dayIndex,
    details: { request_id: result.rows[0].id, photo_record_id: Number(photoRecordId) }
  });
  res.status(202).json({ success: true, pending: true, request_id: result.rows[0].id, message: 'Demande envoyée à un administrateur.' });
  return true;
}

async function performApprovedPhotoDeletion(requestRow) {
  const type = String(requestRow.photo_type || '');
  const id = Number(requestRow.photo_record_id);
  const client = await realPool.connect();
  let fileUrl = '';
  try {
    await client.query('BEGIN');
    if (type === 'petri') {
      const found = await client.query(`SELECT * FROM iso_petri_album_photos WHERE id=$1 FOR UPDATE`, [id]);
      if (!found.rows.length) throw new Error('Photo Petri introuvable.');
      const photo = found.rows[0]; fileUrl = String(photo.file_url || '');
      await client.query(`DELETE FROM iso_reference_phase_images WHERE album_photo_id=$1 OR file_url=$2`, [id,fileUrl]);
      await client.query(`UPDATE iso_petri_journal SET image_url=CASE WHEN image_url=$2 THEN '' ELSE image_url END,reference_image_url=CASE WHEN reference_image_url=$2 THEN '' ELSE reference_image_url END,is_reference=CASE WHEN image_url=$2 OR reference_image_url=$2 THEN FALSE ELSE is_reference END WHERE id=$1 OR (petri_id=$3 AND (image_url=$2 OR reference_image_url=$2))`, [photo.journal_observation_id,fileUrl,photo.petri_id]);
      await client.query(`DELETE FROM iso_petri_album_photos WHERE id=$1`, [id]);
    } else if (type === 'lc') {
      const found = await client.query(`SELECT * FROM lc_pot_journal WHERE id=$1 FOR UPDATE`, [id]);
      if (!found.rows.length) throw new Error('Photo LC introuvable.');
      fileUrl = String(found.rows[0].photo_url || '');
      await client.query(`DELETE FROM lc_reference_day_images WHERE journal_id=$1 OR file_url=$2`, [id,fileUrl]);
      await client.query(`UPDATE lc_pot_journal SET reference_image_url='' WHERE reference_image_url=$1`, [fileUrl]);
      await client.query(`UPDATE lc_pot_journal SET photo_url='',check_photo_done=FALSE WHERE id=$1`, [id]);
    } else if (type === 'grain') {
      const found = await client.query(`SELECT * FROM myc_grain_journal WHERE id=$1 FOR UPDATE`, [id]);
      if (!found.rows.length) throw new Error('Photo grain introuvable.');
      fileUrl = String(found.rows[0].photo_url || '');
      await client.query(`DELETE FROM myc_grain_reference_images WHERE journal_id=$1 OR file_url=$2`, [id,fileUrl]);
      await client.query(`UPDATE myc_grain_journal SET reference_image_url='' WHERE reference_image_url=$1`, [fileUrl]);
      await client.query(`UPDATE myc_grain_journal SET photo_url='' WHERE id=$1`, [id]);
    } else throw new Error('Type de photo inconnu.');
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
  if (fileUrl) {
    let countSql = '';
    if (type === 'petri') countSql = `SELECT (SELECT count(*) FROM iso_petri_journal WHERE image_url=$1 OR reference_image_url=$1)+(SELECT count(*) FROM iso_petri_album_photos WHERE file_url=$1)+(SELECT count(*) FROM iso_reference_phase_images WHERE file_url=$1) AS total`;
    if (type === 'lc') countSql = `SELECT (SELECT count(*) FROM lc_pot_journal WHERE photo_url=$1 OR reference_image_url=$1)+(SELECT count(*) FROM lc_reference_day_images WHERE file_url=$1) AS total`;
    if (type === 'grain') countSql = `SELECT (SELECT count(*) FROM myc_grain_journal WHERE photo_url=$1 OR reference_image_url=$1)+(SELECT count(*) FROM myc_grain_reference_images WHERE file_url=$1) AS total`;
    const refs = await realPool.query(countSql,[fileUrl]);
    if (Number(refs.rows[0]?.total || 0) === 0) await deleteStoredFile(fileUrl, SITE_DIR);
  }
}

const demoRequestStorage = new AsyncLocalStorage();
const demoSessions = new Map();

function sqlTextFromArgs(args) {
  const first = args && args[0];
  if (typeof first === "string") return first;
  if (first && typeof first.text === "string") return first.text;
  return "";
}

function isTransactionControl(sql) {
  return /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\b/i.test(String(sql || ""));
}

function emptyQueryResult(command = "DEMO") {
  return { command, rowCount: null, oid: null, rows: [], fields: [] };
}

function createDemoDbProxy(client) {
  const query = async (...args) => {
    const sql = sqlTextFromArgs(args);
    // Les routes historiques ouvrent/valident parfois leur propre transaction.
    // En visiteur, on neutralise uniquement ces commandes de contrôle pour garder
    // la transaction externe ouverte jusqu'à la fin de la session.
    if (isTransactionControl(sql)) return emptyQueryResult("DEMO_TX");
    return client.query(...args);
  };

  return {
    query,
    connect: async () => ({
      query,
      release: () => {},
      on: (...args) => client.on(...args)
    })
  };
}

async function getOrCreateDemoSession(session) {
  const sid = String(session && session.sid || "");
  if (!sid) throw new Error("Session visiteur invalide");

  const existing = demoSessions.get(sid);
  if (existing) {
    if (existing.ready) {
      existing.expiresAt = Number(session.exp || existing.expiresAt);
      return existing;
    }
    return existing.promise;
  }

  const holder = { ready: false, expiresAt: Number(session.exp || Date.now() + VISITOR_SESSION_HOURS * 3600000) };
  holder.promise = (async () => {
    const client = await realPool.connect();
    try {
      await client.query("BEGIN");
      const entry = {
        ready: true,
        client,
        db: createDemoDbProxy(client),
        expiresAt: holder.expiresAt,
        createdAt: Date.now()
      };
      demoSessions.set(sid, entry);
      return entry;
    } catch (err) {
      try { client.release(); } catch (_) {}
      demoSessions.delete(sid);
      throw err;
    }
  })();
  demoSessions.set(sid, holder);
  return holder.promise;
}

function removeDemoFilesBySid(sid) {
  const prefix = `DEMO-${sid}-`;
  const roots = [path.join(SITE_DIR, "uploads"), path.join(__dirname, "uploads")];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.startsWith(prefix)) {
        try { fs.unlinkSync(full); } catch (_) {}
      }
    }
  };
  roots.forEach(walk);
}

function cleanupStaleDemoFiles() {
  const roots = [path.join(SITE_DIR, "uploads"), path.join(__dirname, "uploads")];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) walk(full);
      else if (/^DEMO-[a-f0-9]{32}-/i.test(name)) {
        try { fs.unlinkSync(full); } catch (_) {}
      }
    }
  };
  roots.forEach(walk);
}

async function closeDemoSession(sid) {
  const key = String(sid || "");
  const entry = demoSessions.get(key);
  if (!entry) {
    removeDemoFilesBySid(key);
    await deleteDemoSupabaseFiles(key);
    return;
  }
  demoSessions.delete(key);
  let ready = entry;
  if (!entry.ready && entry.promise) {
    try { ready = await entry.promise; } catch (_) { ready = null; }
  }
  if (ready && ready.client) {
    try { await ready.client.query("ROLLBACK"); } catch (_) {}
    try { ready.client.release(); } catch (_) {}
  }
  removeDemoFilesBySid(key);
  await deleteDemoSupabaseFiles(key);
}

const pool = {
  query: (...args) => {
    const ctx = demoRequestStorage.getStore();
    return ctx && ctx.db ? ctx.db.query(...args) : realPool.query(...args);
  },
  connect: () => {
    const ctx = demoRequestStorage.getStore();
    return ctx && ctx.db ? ctx.db.connect() : realPool.connect();
  },
  end: (...args) => realPool.end(...args)
};

cleanupStaleDemoFiles();
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of demoSessions.entries()) {
    if (Number(entry.expiresAt || 0) <= now) {
      closeDemoSession(sid).catch((err) => console.error("Demo rollback expiry:", err.message));
    }
  }
}, 5 * 60 * 1000).unref();

// Injecte la base transactionnelle temporaire uniquement pour le visiteur.
app.use("/api", async (req, res, next) => {
  if (!req.adminSession || req.adminSession.role !== "visitor") return next();
  try {
    const demo = await getOrCreateDemoSession(req.adminSession);
    req.demoMode = true;
    req.db = demo.db;
    return demoRequestStorage.run({ db: demo.db, sid: req.adminSession.sid }, next);
  } catch (err) {
    console.error("Initialisation session visiteur:", err);
    return res.status(503).json({ error: "Mode démonstration indisponible : " + (err.message || err.code || "connexion PostgreSQL impossible") });
  }
});

// ============================================================
// UTILISATEURS, ROLES, PRESENCE ET APPROBATIONS (Supabase Auth)
// ============================================================
app.post('/api/auth/heartbeat', async (req, res) => {
  if (!req.adminSession?.userId) return res.status(204).end();
  try {
    await ensureUserManagementSchema();
    await realPool.query(`UPDATE app_users SET last_seen_at=now() WHERE auth_user_id=$1`, [req.adminSession.userId]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/roles', requirePermission('users.manage'), async (_req, res) => {
  try {
    await ensureUserManagementSchema();
    const result = await realPool.query(`SELECT id,code,name FROM app_roles ORDER BY CASE code WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,name`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requirePermission('users.manage'), async (_req, res) => {
  try {
    await ensureUserManagementSchema();
    const result = await realPool.query(`
      SELECT u.auth_user_id AS id,u.email,u.username,u.display_name,u.active,u.must_change_password,
             u.last_seen_at,u.created_at,r.code AS role,r.name AS role_name,
             (u.active AND u.last_seen_at >= now()-interval '15 minutes') AS online
      FROM app_users u JOIN app_roles r ON r.id=u.role_id
      ORDER BY online DESC,lower(u.username)
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const productionModuleLabels = { petri:'Boîtes de Petri',lc:'Mycélium liquide',grain:'Mycélium sur grain' };
const productionActionLabels = { added:'Ajout du suivi',modified:'Modification du suivi',photo_added:'Photo ajoutée',delete_requested:'Suppression demandée',photo_deleted:'Photo supprimée',delete_approved:'Suppression approuvée',delete_rejected:'Suppression refusée' };

async function loadProductionActivityReport(query) {
  await ensureUserManagementSchema();
  const month = String(query.month || '').trim();
  const moduleName = String(query.module || '').trim();
  const userId = String(query.user_id || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { const e=new Error('Mois invalide (format YYYY-MM).');e.status=400;throw e; }
  if (moduleName && !['petri','lc','grain'].includes(moduleName)) { const e=new Error('Module invalide.');e.status=400;throw e; }
  const [year, monthNumber] = month.split('-').map(Number);
  const values = [year, monthNumber];
  const filters = [`a.created_at >= make_timestamptz($1,$2,1,0,0,0,'Europe/Berlin')`, `a.created_at < make_timestamptz($1,$2,1,0,0,0,'Europe/Berlin') + interval '1 month'`];
  if (moduleName) { values.push(moduleName); filters.push(`a.module=$${values.length}`); }
  if (userId) { values.push(userId); filters.push(`a.actor_user_id=$${values.length}::uuid`); }
  const where = filters.join(' AND ');
  const rows = await realPool.query(`
    SELECT a.id,a.actor_user_id,a.actor_name,a.actor_role,a.module,a.action_type,a.item_id,
           a.item_label,a.day_index,a.details,a.created_at,
           to_char(a.created_at AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD') AS activity_day
    FROM production_activity_log a WHERE ${where}
    ORDER BY a.created_at DESC,a.id DESC LIMIT 2000
  `, values);
  const summary = await realPool.query(`
    SELECT count(*)::int AS total_actions,
           count(DISTINCT (a.module,a.item_id))::int AS distinct_items,
           count(DISTINCT (a.created_at AT TIME ZONE 'Europe/Berlin')::date)::int AS active_days
    FROM production_activity_log a WHERE ${where}
  `, values);
  let operatorLabel = 'Tous les opérateurs';
  if (userId) {
    const user = await realPool.query(`SELECT username FROM app_users WHERE auth_user_id=$1::uuid`,[userId]);
    operatorLabel = user.rows[0]?.username || userId;
  }
  return {
    rows: rows.rows,
    summary: summary.rows[0] || { total_actions:0,distinct_items:0,active_days:0 },
    filters: { month,operator:operatorLabel,module:moduleName ? productionModuleLabels[moduleName] : 'Tous les modules' }
  };
}

app.get('/api/admin/production-activity', requirePermission('users.manage'), async (req, res) => {
  try { res.json(await loadProductionActivityReport(req.query)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/admin/production-activity/export.xlsx', requirePermission('users.manage'), async (req, res) => {
  try {
    const report = await loadProductionActivityReport(req.query);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Mycelium Tech Digital';
    workbook.created = new Date();
    const summarySheet = workbook.addWorksheet('Résumé',{views:[{showGridLines:false}]});
    summarySheet.columns=[{width:28},{width:34}];
    summarySheet.mergeCells('A1:B1');summarySheet.getCell('A1').value='Suivi de l’activité de production';
    summarySheet.getCell('A1').font={bold:true,size:18,color:{argb:'FFFFFFFF'}};summarySheet.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F7A41'}};summarySheet.getCell('A1').alignment={vertical:'middle'};summarySheet.getRow(1).height=30;
    [['Mois',report.filters.month],['Opérateur',report.filters.operator],['Module',report.filters.module],['Actions au total',report.summary.total_actions],['Éléments distincts',report.summary.distinct_items],['Jours actifs',report.summary.active_days]].forEach((r,i)=>{const row=summarySheet.getRow(i+3);row.values=r;row.getCell(1).font={bold:true,color:{argb:'FF1F7A41'}};row.getCell(2).alignment={horizontal:'left'};});
    const sheet = workbook.addWorksheet('Activités',{views:[{state:'frozen',ySplit:1}]});
    sheet.columns=[{header:'Date et heure',key:'date',width:22},{header:'Opérateur',key:'operator',width:22},{header:'Rôle',key:'role',width:16},{header:'Module',key:'module',width:23},{header:'Élément travaillé',key:'item',width:30},{header:'ID',key:'id',width:12},{header:'Jour cycle',key:'day',width:12},{header:'Action',key:'action',width:26}];
    report.rows.forEach(x=>sheet.addRow({date:new Date(x.created_at),operator:x.actor_name,role:x.actor_role,module:productionModuleLabels[x.module]||x.module,item:x.item_label,id:x.item_id,day:x.day_index==null?'':x.day_index,action:productionActionLabels[x.action_type]||x.action_type}));
    sheet.getColumn('date').numFmt='dd/mm/yyyy hh:mm';
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F7A41'}};sheet.getRow(1).alignment={vertical:'middle'};sheet.getRow(1).height=24;
    sheet.autoFilter={from:'A1',to:'H1'};sheet.eachRow((row,rowNumber)=>{if(rowNumber>1){if(rowNumber%2===1)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F7F2'}};row.alignment={vertical:'top'};}});
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="suivi-activite-${report.filters.month}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) { res.status(e.status || 500).json({ error:e.message }); }
});

app.get('/api/admin/production-activity/export.pdf', requirePermission('users.manage'), async (req, res) => {
  try {
    const report = await loadProductionActivityReport(req.query);
    const doc = new PDFDocument({size:'A4',layout:'landscape',margin:34,info:{Title:'Suivi de l’activité de production',Author:'Mycelium Tech Digital'}});
    const chunks=[];doc.on('data',c=>chunks.push(c));const completed=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
    let page=1;
    const widths=[88,94,105,170,48,137],left=34,rowHeight=22;
    const drawHeader=()=>{
      doc.fillColor('#1f7a41').font('Helvetica-Bold').fontSize(17).text('Suivi de l’activité de production',left,28);
      doc.fillColor('#425348').font('Helvetica').fontSize(9).text(`Mois : ${report.filters.month}   |   Opérateur : ${report.filters.operator}   |   Module : ${report.filters.module}`,left,53);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1f7a41').text(`Actions : ${report.summary.total_actions}     Éléments distincts : ${report.summary.distinct_items}     Jours actifs : ${report.summary.active_days}`,left,70);
      const y=92;doc.rect(left,y,widths.reduce((a,b)=>a+b,0),20).fill('#1f7a41');
      const headers=['Date','Opérateur','Module','Élément','Jour','Action'];let x=left;doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);headers.forEach((h,i)=>{doc.text(h,x+4,y+6,{width:widths[i]-8,height:10});x+=widths[i];});
      return 112;
    };
    const footer=()=>doc.fillColor('#667085').font('Helvetica').fontSize(8).text(`Mycelium Tech Digital - page ${page}`,left,558,{width:773,align:'right'});
    let y=drawHeader();
    for(const x of report.rows){
      if(y+rowHeight>550){footer();doc.addPage();page+=1;y=drawHeader();}
      if((Math.floor((y-112)/rowHeight)%2)===1)doc.rect(left,y,widths.reduce((a,b)=>a+b,0),rowHeight).fill('#f0f7f2');
      const values=[new Date(x.created_at).toLocaleString('fr-FR',{timeZone:'Europe/Berlin'}),x.actor_name,productionModuleLabels[x.module]||x.module,x.item_label,x.day_index==null?'-':`J${x.day_index}`,productionActionLabels[x.action_type]||x.action_type];
      let cellX=left;doc.fillColor('#26352b').font('Helvetica').fontSize(7.5);values.forEach((value,i)=>{doc.text(String(value),cellX+4,y+6,{width:widths[i]-8,height:rowHeight-8,ellipsis:true});cellX+=widths[i];});
      doc.moveTo(left,y+rowHeight).lineTo(left+widths.reduce((a,b)=>a+b,0),y+rowHeight).strokeColor('#dce6df').lineWidth(.4).stroke();y+=rowHeight;
    }
    if(!report.rows.length)doc.fillColor('#667085').font('Helvetica').fontSize(10).text('Aucune activité pour les filtres sélectionnés.',left,y+15);
    footer();doc.end();const buffer=await completed;
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="suivi-activite-${report.filters.month}.pdf"`);res.send(buffer);
  } catch (e) { res.status(e.status || 500).json({ error:e.message }); }
});

app.post('/api/admin/users', requirePermission('users.manage'), async (req, res) => {
  try {
    await ensureUserManagementSchema();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const username = String(req.body?.username || '').trim();
    const displayName = String(req.body?.display_name || username).trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'operator').trim();
    if (!email || !username || password.length < 10) return res.status(400).json({ error: 'Email, nom utilisateur et mot de passe (10 caractères minimum) requis.' });
    const roleResult = await realPool.query(`SELECT id FROM app_roles WHERE code=$1`, [role]);
    if (!roleResult.rows.length) return res.status(400).json({ error: 'Rôle invalide.' });
    const { data, error } = await getSupabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username, display_name: displayName } });
    if (error || !data?.user) throw error || new Error('Création Supabase impossible');
    try {
      await realPool.query(`INSERT INTO app_users(auth_user_id,email,username,display_name,role_id,active,must_change_password) VALUES($1,$2,$3,$4,$5,TRUE,TRUE) ON CONFLICT(auth_user_id) DO UPDATE SET email=EXCLUDED.email,username=EXCLUDED.username,display_name=EXCLUDED.display_name,role_id=EXCLUDED.role_id,active=TRUE,must_change_password=TRUE,updated_at=now()`, [data.user.id,email,username,displayName,roleResult.rows[0].id]);
    } catch (dbError) {
      await getSupabaseAdmin().auth.admin.deleteUser(data.user.id).catch(() => {});
      throw dbError;
    }
    res.status(201).json({ success: true, id: data.user.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', requirePermission('users.manage'), async (req, res) => {
  try {
    await ensureUserManagementSchema();
    const userId = String(req.params.id || '');
    const current = await loadApplicationUser(userId);
    if (!current) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const email = String(req.body?.email || current.email).trim().toLowerCase();
    const username = String(req.body?.username || current.username).trim();
    const displayName = String(req.body?.display_name ?? current.display_name ?? username).trim();
    const role = String(req.body?.role || current.role).trim();
    if (userId === req.adminSession?.userId && role !== 'admin') return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre rôle administrateur.' });
    const rr = await realPool.query(`SELECT id FROM app_roles WHERE code=$1`, [role]);
    if (!rr.rows.length) return res.status(400).json({ error: 'Rôle invalide.' });
    if (email !== current.email) {
      const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, { email, email_confirm: true });
      if (error) throw error;
    }
    await realPool.query(`UPDATE app_users SET email=$2,username=$3,display_name=$4,role_id=$5,updated_at=now() WHERE auth_user_id=$1`, [userId,email,username,displayName,rr.rows[0].id]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/freeze', requirePermission('users.manage'), async (req, res) => {
  try {
    const userId = String(req.params.id || '');
    if (userId === req.adminSession?.userId) return res.status(400).json({ error: 'Vous ne pouvez pas geler votre propre compte.' });
    await ensureUserManagementSchema();
    const active = req.body?.active === true;
    const result = await realPool.query(`UPDATE app_users SET active=$2,updated_at=now() WHERE auth_user_id=$1 RETURNING auth_user_id`, [userId,active]);
    if (!result.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ success: true, active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/force-password', requirePermission('users.manage'), async (req, res) => {
  try {
    const password = String(req.body?.temporary_password || '');
    if (password.length < 10) return res.status(400).json({ error: 'Le mot de passe temporaire doit contenir au moins 10 caractères.' });
    const userId = String(req.params.id || '');
    const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, { password });
    if (error) throw error;
    await realPool.query(`UPDATE app_users SET must_change_password=TRUE,updated_at=now() WHERE auth_user_id=$1`, [userId]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requirePermission('users.manage'), async (req, res) => {
  try {
    const userId = String(req.params.id || '');
    if (userId === req.adminSession?.userId) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
    const { error } = await getSupabaseAdmin().auth.admin.deleteUser(userId);
    if (error) throw error;
    await realPool.query(`DELETE FROM app_users WHERE auth_user_id=$1`, [userId]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/photo-deletion-requests', requirePermission('photo.delete.approve'), async (_req, res) => {
  try {
    await ensureUserManagementSchema();
    const result = await realPool.query(`SELECT * FROM photo_deletion_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,requested_at DESC LIMIT 300`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/photo-deletion-requests/:id/reject', requirePermission('photo.delete.approve'), async (req, res) => {
  try {
    const result = await realPool.query(`UPDATE photo_deletion_requests SET status='rejected',reviewed_by=$2,reviewed_by_name=$3,reviewed_at=now(),review_note=$4 WHERE id=$1 AND status='pending' RETURNING *`, [Number(req.params.id),req.adminSession?.userId || null,req.adminSession?.username || 'Admin',String(req.body?.note || '')]);
    if (!result.rows.length) return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });
    await recordProductionActivity(req, deletionReviewActivity(result.rows[0], 'delete_rejected'));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/photo-deletion-requests/:id/approve', requirePermission('photo.delete.approve'), async (req, res) => {
  const client = await realPool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM photo_deletion_requests WHERE id=$1 FOR UPDATE`, [Number(req.params.id)]);
    if (!locked.rows.length || locked.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });
    }
    await performApprovedPhotoDeletion(locked.rows[0]);
    await client.query(`UPDATE photo_deletion_requests SET status='approved',reviewed_by=$2,reviewed_by_name=$3,reviewed_at=now(),review_note=$4 WHERE id=$1 AND status='pending'`, [Number(req.params.id),req.adminSession?.userId || null,req.adminSession?.username || 'Admin',String(req.body?.note || '')]);
    await client.query('COMMIT');
    await recordProductionActivity(req, deletionReviewActivity(locked.rows[0], 'delete_approved'));
    res.json({ success: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});


// ============================================================
// RÉFÉRENCES JOURNALIÈRES PAR GROUPE BIOLOGIQUE
// Logique corrigée : une référence = isolement + phase P + jour J.
// La photo réelle reste liée à la boîte précise.
// ============================================================
let referenceDaySchemaReady = false;
async function ensureReferenceDaySchema() {
  if (referenceDaySchemaReady) return;

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS iso_reference_phase_images (
      id SERIAL PRIMARY KEY,
      isolement_id INTEGER NOT NULL,
      phase INTEGER NOT NULL,
      day_index INTEGER NOT NULL DEFAULT 0,
      album_photo_id INTEGER,
      source_petri_id INTEGER,
      file_url TEXT NOT NULL,
      note20 NUMERIC DEFAULT 10,
      commentaire TEXT,
      updated_at TIMESTAMP DEFAULT now()
    )
  `);

  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS day_index INTEGER NOT NULL DEFAULT 0`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS album_photo_id INTEGER`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS source_petri_id INTEGER`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS file_url TEXT`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS note20 NUMERIC DEFAULT 10`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS commentaire TEXT`);
  await realPool.query(`ALTER TABLE iso_reference_phase_images ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now()`);

  // Si une ancienne version avait une contrainte unique seulement sur (isolement_id, phase),
  // elle empêcherait P1-J0, P1-J1, P1-J2... de coexister. On la supprime proprement.
  await realPool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'iso_reference_phase_images'::regclass
          AND contype = 'u'
          AND (
            SELECT array_agg(attname::text ORDER BY attname::text)
            FROM unnest(conkey) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum
          ) = ARRAY['isolement_id','phase']::text[]
      LOOP
        EXECUTE format('ALTER TABLE iso_reference_phase_images DROP CONSTRAINT %I', r.conname);
      END LOOP;
    END $$;
  `);

  await realPool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname AS index_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'iso_reference_phase_images'::regclass
          AND i.indisunique = true
          AND i.indisprimary = false
          AND (
            SELECT array_agg(a.attname::text ORDER BY a.attname::text)
            FROM unnest(i.indkey) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          ) = ARRAY['isolement_id','phase']::text[]
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
      END LOOP;
    END $$;
  `);

  await realPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_iso_reference_phase_day
    ON iso_reference_phase_images (isolement_id, phase, day_index)
  `);

  await realPool.query(`ALTER TABLE iso_petri_album_photos ADD COLUMN IF NOT EXISTS phase INTEGER`);
  await realPool.query(`ALTER TABLE iso_petri_album_photos ADD COLUMN IF NOT EXISTS day_index INTEGER NOT NULL DEFAULT 0`);
  await realPool.query(`ALTER TABLE iso_petri_album_photos ADD COLUMN IF NOT EXISTS is_reference_candidate BOOLEAN DEFAULT FALSE`);

  referenceDaySchemaReady = true;
}

async function upsertDailyReference({ isolementId, phase, dayIndex, albumPhotoId, petriId, fileUrl, commentaire }) {
  await ensureReferenceDaySchema();
  let existing = await pool.query(
    `SELECT id FROM iso_reference_phase_images WHERE isolement_id=$1 AND phase=$2 AND day_index=$3 LIMIT 1`,
    [isolementId, phase, dayIndex]
  );

  if (existing.rows.length) {
    await pool.query(
      `UPDATE iso_reference_phase_images
       SET album_photo_id=$1, source_petri_id=$2, file_url=$3, note20=10, commentaire=$4, updated_at=now()
       WHERE id=$5`,
      [albumPhotoId, petriId, fileUrl, commentaire, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO iso_reference_phase_images
         (isolement_id, phase, day_index, album_photo_id, source_petri_id, file_url, note20, commentaire, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,10,$7,now())`,
      [isolementId, phase, dayIndex, albumPhotoId, petriId, fileUrl, commentaire]
    );
  }

  await pool.query(
    `UPDATE iso_petri_album_photos
     SET is_reference_candidate = (id=$1)
     WHERE isolement_id=$2 AND phase=$3 AND day_index=$4`,
    [albumPhotoId, isolementId, phase, dayIndex]
  );
}

// ✅ NOUVEAU : Middleware pour injecter le pool DB dans toutes les requêtes
app.use((req, res, next) => {
  if (!req.db) req.db = pool;
  next();
});

app.use('/api', strainsRoutes);
app.use('/api', cyclesRoutes);

// Admin-only root
app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

let lcRoutes = require('./routes/lc');
app.use('/api', lcRoutes);
// ===== Helpers gÃ©nÃ©raux =====
function pad(n) {
  return String(n).padStart(2, "0");
}
function genCode(prefix) {
  // Exemple: ISO-20251229-194501-482
  let d = new Date();
  let y = d.getFullYear();
  let m = pad(d.getMonth() + 1);
  let day = pad(d.getDate());
  let hh = pad(d.getHours());
  let mm = pad(d.getMinutes());
  let ss = pad(d.getSeconds());
  let rnd = Math.floor(Math.random() * 900 + 100);
  return `${prefix}-${y}${m}${day}-${hh}${mm}${ss}-${rnd}`;
}

function demoUploadPrefix(req) {
  return req && req.adminSession && req.adminSession.role === "visitor" && req.adminSession.sid
    ? `DEMO-${req.adminSession.sid}-`
    : "";
}

// âœ… Multer (upload photos cycle biologique)
function generatedUploadName(req, file, prefix, fallbackExt = '.jpg') {
  const ext = safeExtension(file && file.originalname, fallbackExt);
  const safe = genCode(prefix).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${demoUploadPrefix(req)}${safe}${ext}`;
}

function makeUploadStorage(localDir, prefix, fallbackExt = '.jpg') {
  if (USE_CLOUD_STORAGE) return multer.memoryStorage();
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, localDir),
    filename: (req, file, cb) => cb(null, generatedUploadName(req, file, prefix, fallbackExt)),
  });
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

function imageFileFilter(req, file, cb) {
  if (!file || !ALLOWED_IMAGE_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
    return cb(new Error('Formats photo autorises: JPEG, PNG, WebP, AVIF, HEIC ou HEIF'));
  }
  cb(null, true);
}

let storage = makeUploadStorage(UPLOAD_DIR, 'ISOIMG');
let upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES }, fileFilter: imageFileFilter });
let lcPhotoStorage = makeUploadStorage(LC_UPLOAD_DIR, 'LCIMG');
let lcUpload = multer({ storage: lcPhotoStorage, limits: { fileSize: MAX_UPLOAD_BYTES }, fileFilter: imageFileFilter });
let grainPhotoStorage = makeUploadStorage(GRAIN_UPLOAD_DIR, 'GRAINIMG');
let grainUpload = multer({ storage: grainPhotoStorage, limits: { fileSize: MAX_UPLOAD_BYTES }, fileFilter: imageFileFilter });

let ISO_ACTIVE_STATUSES = [
  "EN_PREPARATION",
  "EN_INCUBATION",
  "PRETE",
  "PERIMEE",
  "A_DETRUIRE",
];

let isoPetrisStorageSchemaReady = false;
async function ensureIsoPetrisStorageSchema() {
  if (isoPetrisStorageSchemaReady) return;
  await realPool.query(`ALTER TABLE iso_petris ADD COLUMN IF NOT EXISTS storage_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE iso_petris ADD COLUMN IF NOT EXISTS storage_limit_at TIMESTAMP`);
  isoPetrisStorageSchemaReady = true;
}

// ============================================================
// ISO PETRI + GELOSE (P1/P2/P3) â€” Extensions "mÃ©tier" isolement
// ============================================================
// ============================================
// ROUTES API POUR VALIDATION P3
// À ajouter dans server.js (AVANT app.listen)
// ============================================

// ✅ ROUTE 1 : VALIDER UN P3
app.put('/api/boites/:id/valider-p3', async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que la boîte existe
    let check = await pool.query(
      `SELECT id_boite, code_boite, statut_boite FROM boites_isolement WHERE id_boite = $1`,
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Boîte non trouvée' });
    }

    let boite = check.rows[0];

    // ⚠️ Vérifier si déjà validé (protection contre double validation)
    if (boite.statut_boite === 'VALIDÉ') {
      return res.status(400).json({ 
        error: 'Ce P3 est déjà validé. Un P3 ne peut être validé qu\'une seule fois.' 
      });
    }

    // ✅ Changer le statut vers VALIDÉ
    await pool.query(
      `UPDATE boites_isolement 
       SET statut_boite = 'VALIDÉ', 
           date_modification = CURRENT_TIMESTAMP 
       WHERE id_boite = $1`,
      [id]
    );

    res.json({
      success: true,
      message: `P3 ${boite.code_boite} validé avec succès`
    });

  } catch (err) {
    console.error('Erreur PUT /api/boites/:id/valider-p3:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ ROUTE 2 : RÉCUPÉRER INFOS BOÎTE (pour vérifier le statut)
app.get('/api/boites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    let result = await pool.query(
      `SELECT * FROM boites_isolement WHERE id_boite = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Boîte non trouvée' });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (err) {
    console.error('Erreur GET /api/boites/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// FIN DES ROUTES
// ============================================

// ===============================
// CYCLES RULES (AGARICUS / PLEUROTUS)
// J0 = date_prelev
// ===============================
function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// âœ… IMPORTANT: gÃ¨re string ET Date (PostgreSQL renvoie parfois Date)
function parseYMD(s) {
  if (!s) return null;

  // si dÃ©jÃ  un Date()
  if (s instanceof Date) {
    let dt = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // si string "YYYY-MM-DD" ou timestamp -> on prend les 10 premiers chars
  let str = String(s).slice(0, 10);
  let p = str.split("-");
  if (p.length !== 3) return null;

  const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function diffDays(a, b) {
  let A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  let B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((B - A) / 86400000);
}

let CYCLE_RULES = {
  PLEUROTUS: [
    {
      step: 0,
      name: "Boîte stérile",
      jMin: -9999,
      jMax: -1,
      status: "A_PLANIFIER",
      instruction: "Préparer boîtes stériles + étiquettes. Vérifier zone aseptique.",
    },
    {
      step: 1,
      name: "Inoculation",
      jMin: 0,
      jMax: 0,
      status: "EN_COURS",
      instruction:
        "Clonage sur gélose (tissu interne). Étiqueter ISO, date, opérateur. Incuber.",
    },
    {
      step: 2,
      name: "Incubation",
      jMin: 1,
      jMax: 5,
      status: "A_VERIFIER",
      instruction:
        "Contrôle visuel quotidien (sans ouvrir) : croissance, condensation, couleur/odeur.",
    },
    {
      step: 3,
      name: "Purification",
      jMin: 6,
      jMax: 8,
      status: "A_REPIQUER",
      instruction:
        "Repiquage si secteurs/contamination. Prélever zone la plus blanche/forte. FENÊTRE OPTIMALE.",
    },
    {
      step: 4,
      name: "Boîte mère validée",
      jMin: 9,
      jMax: 10,
      status: "VALIDE",
      instruction:
        "Valider uniformité + absence de contamination. Photo + signature opérateur.",
    },
    {
      step: 5,
      name: "Production",
      jMin: 11,
      jMax: 10,
      status: "PRETE",
      instruction:
        "Production : inoculer LC / grains / nouvelles boîtes. Enregistrer lots enfants.",
    },
    {
      step: 6,
      name: "Fin de vie",
      jMin: 11,
      jMax: 9999,
      status: "A_DETRUIRE",
      instruction: "Fin de vie : condamner, détruire selon protocole, archiver.",
    },
  ],

  AGARICUS: [
    {
      step: 0,
      name: "Boîte stérile",
      jMin: -9999,
      jMax: -1,
      status: "A_PLANIFIER",
      instruction: "Préparer boîtes stériles + étiquettes. Vérifier zone aseptique.",
    },
    {
      step: 1,
      name: "Inoculation",
      jMin: 0,
      jMax: 0,
      status: "EN_COURS",
      instruction:
        "Clonage sur gélose (tissu interne). Étiqueter ISO, date, opérateur. Incuber.",
    },
    {
      step: 2,
      name: "Adaptation / incubation",
      jMin: 1,
      jMax: 13,
      status: "A_VERIFIER",
      instruction:
        "Contrôle visuel quotidien : le Champignon de Paris peut nécessiter environ 14 jours pour s'adapter à un nouveau milieu de culture.",
    },
    {
      step: 3,
      name: "Contrôle adaptation / P3",
      jMin: 14,
      jMax: 14,
      status: "A_VERIFIER",
      instruction:
        "Remarque BiotechAgro validée par tests : pour un transfert gélose → solution nutritive, utiliser un P3 validé et prélever un micro-fragment avec le minimum de gélose possible (découpe superficielle 0,2 à 0,5 mm). Cette méthode permet un démarrage LC rapide et conforme à la cinétique théorique.",
    },
    {
      step: 4,
      name: "Boîte mère validée",
      jMin: 15,
      jMax: 15,
      status: "VALIDE",
      instruction:
        "Valider uniformité + absence de contamination. Photo + signature opérateur.",
    },
    {
      step: 5,
      name: "Production",
      jMin: 16,
      jMax: 16,
      status: "PRETE",
      instruction:
        "Production : inoculer LC / grains. Démarrer lots test si nécessaire.",
    },
    {
      step: 6,
      name: "Fin de vie",
      jMin: 17,
      jMax: 9999,
      status: "A_DETRUIRE",
      instruction: "Fin de vie : condamner, détruire selon protocole, archiver.",
    },
  ],
};

// Calcule lâ€™Ã©tat â€œaujourdâ€™huiâ€ Ã  partir de date_prelev + cycle_type + date_exp
function computeIsoState(iso) {
  let now = new Date();
  let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let prelev = parseYMD(iso.date_prelev);
  let exp = parseYMD(iso.date_exp);

  if (!prelev) {
    return {
      j_plus: null,
      step_index: null,
      step_name: "â€”",
      status_calc: "A_PLANIFIER",
      instruction_today: "Renseigner date_prelev pour dÃ©marrer le cycle.",
      is_expired: false,
    };
  }

  let j = diffDays(prelev, today);

  // expiration prime
  if (exp && today > exp) {
    return {
      j_plus: j,
      step_index: 6,
      step_name: "Fin de vie",
      status_calc: "PERIMEE",
      instruction_today:
        "Date dâ€™expiration dÃ©passÃ©e : passer Ã  A_DETRUIRE puis ARCHIVEE.",
      is_expired: true,
    };
  }

  let cycle = String(iso.cycle_type || "").trim().toUpperCase();
  let rules = CYCLE_RULES[cycle] || CYCLE_RULES.PLEUROTUS;
  let r = rules.find((x) => j >= x.jMin && j <= x.jMax) || rules[rules.length - 1];

  return {
    j_plus: j,
    step_index: r.step,
    step_name: r.name,
    status_calc: r.status,
    instruction_today: r.instruction,
    is_expired: false,
  };
}

// ===== Health =====
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ===== STRAINS =====
// ❌ ANCIENNE ROUTE OBSOLÈTE - DÉSACTIVÉE
// Utiliser maintenant GET /api/strains dans routes/strains.js
// app.get("/api/strains", async (req, res) => {
//   try {
//     let q = `
//       SELECT id, code, species, name, strain_type,
//              certificate_available, certification_status, production_allowed,
//              created_at
//       FROM strains
//       ORDER BY created_at DESC
//       LIMIT 200;
//     `;
//     const r = await pool.query(q);
//     res.json(r.rows);
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// ❌ ANCIENNE ROUTE OBSOLÈTE - DÉSACTIVÉE
// Cette route utilisait la colonne 'supplier' qui n'existe plus
// Utiliser maintenant les routes dans routes/strains.js qui utilisent 'source_name' et 'source_ref'
// app.post("/api/strains", async (req, res) => {
//   try {
//     const {
//       code,
//       species,
//       name,
//       strain_type = "INTERNAL",
//       certificate_available = false,
//       certification_status = "NOT_CERTIFIED",
//       production_allowed = false,
//       supplier = null,
//       received_at = null,
//       quantity = null,
//     } = req.body || {};
// 
//     if (!code || !species || !name) {
//       return res.status(400).json({ error: "code, species, name sont obligatoires" });
//     }
// 
//     let safeProductionAllowed =
//       certification_status === "CERTIFIED" ? Boolean(production_allowed) : false;
// 
//     const q = `
//       INSERT INTO strains
//         (code, species, name, strain_type, certificate_available, certification_status, production_allowed,
//          supplier, received_at, quantity)
//       VALUES
//         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
//       RETURNING *;
//     `;
//     const r = await pool.query(q, [
//       code,
//       species,
//       name,
//       strain_type,
//       Boolean(certificate_available),
//       certification_status,
//       safeProductionAllowed,
//       supplier,
//       received_at,
//       quantity,
//     ]);
// 
//     res.status(201).json(r.rows[0]);
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// ===== ISOLEMENTS =====
app.get("/api/isolements", async (req, res) => {
  try {
    let status = String(req.query.status || "ACTIF").toUpperCase();
    const q = String(req.query.q || "").trim();
    let includeArchived = String(req.query.includeArchived || "0") === "1";

    let where = [];
    let params = [];

    if (status && status !== "TOUS") {
      if (status === "ACTIF") {
        params.push(ISO_ACTIVE_STATUSES);
        where.push(`statut = ANY($${params.length})`);
      } else {
        params.push(status);
        where.push(`statut = $${params.length}`);
      }
    }

    if (!includeArchived) {
      where.push(`statut <> 'ARCHIVEE'`);
    }

    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      where.push(
        `(code ILIKE ${p} OR champignon ILIKE ${p} OR origine ILIKE ${p} OR categorie ILIKE ${p})`
      );
    }

    let sql = `
      SELECT id, code, champignon, cycle_type, categorie, origine, infos,
             agar, date_prepa, date_prelev, date_exp, operateur,
             solution_lc, statut, global_status, created_at, updated_at
      FROM isolements
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT 500;
    `;

    const r = await pool.query(sql, params);
    let list = r.rows.map((x) => ({ ...x, ...computeIsoState(x) }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/isolements", async (req, res) => {
  try {
    let b = req.body || {};

    let cycle_type = String(b.cycle_type || "").trim().toUpperCase();
    let allowedCycles = new Set(["AGARICUS", "PLEUROTUS"]);
    if (!allowedCycles.has(cycle_type)) {
      return res.status(400).json({
        error: "cycle_type invalide. Valeurs acceptÃ©es: AGARICUS, PLEUROTUS",
      });
    }

    let champignon = String(b.champignon || "").trim();
    let categorie = String(b.categorie || "").trim();
    let origine = String(b.origine || "").trim();
    let infos = b.infos === undefined || b.infos === null ? "" : String(b.infos);

    let date_prepa = String(b.date_prepa || "").trim();
    let date_prelev = String(b.date_prelev || "").trim();
    let date_exp = String(b.date_exp || "").trim();
    let operateur = String(b.operateur || "").trim();

    let agar = b.agar && typeof b.agar === "object" ? b.agar : null;
    let solution_lc = b.solution_lc && typeof b.solution_lc === "object" ? b.solution_lc : null;

    if (!champignon || !categorie || !origine || !date_prepa || !date_prelev || !date_exp || !operateur) {
      return res.status(400).json({ error: "Champs obligatoires manquants" });
    }

    // Validation dates (exp > prelev)
    const prelev = new Date(date_prelev);
    const exp = new Date(date_exp);
    if (Number.isNaN(prelev.getTime()) || Number.isNaN(exp.getTime())) {
      return res.status(400).json({ error: "Format date invalide (YYYY-MM-DD attendu)." });
    }
    if (exp.getTime() <= prelev.getTime()) {
      return res.status(400).json({ error: "date_exp doit Ãªtre strictement supÃ©rieure Ã  date_prelev." });
    }

    let code = genCode("ISO");
    let toJsonOrNull = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

    const sql = `
      INSERT INTO isolements
        (code, champignon, cycle_type, categorie, origine, infos,
         agar, date_prepa, date_prelev, date_exp, operateur,
         solution_lc, statut)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'EN_INCUBATION')
      RETURNING *;
    `;

    const r = await pool.query(sql, [
      code,
      champignon,
      cycle_type,
      categorie,
      origine,
      infos,
      toJsonOrNull(agar),
      date_prepa,
      date_prelev,
      date_exp,
      operateur,
      toJsonOrNull(solution_lc),
    ]);

    let created = r.rows[0];
    res.status(201).json({ ...created, ...computeIsoState(created) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET un isolement par ID
app.get("/api/isolements/:id", async (req, res) => {
  try {
    let id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id invalide" });

    const sql = `
      SELECT id, code, champignon, cycle_type, categorie, origine, infos,
             agar, date_prepa, date_prelev, date_exp, operateur,
             solution_lc, statut, global_status, created_at, updated_at
      FROM isolements
      WHERE id = $1
      LIMIT 1;
    `;
    const r = await pool.query(sql, [id]);
    if (!r.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    let iso = r.rows[0];
    res.json({ ...iso, ...computeIsoState(iso) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// PATCH /api/isolements/:id/solution-lc
// Compatibilité avec admin-isolement.html : enregistre la recette de solution nutritive
// envoyée sous la forme { solution_lc: {...} }.
// Cette route évite l'erreur 404 au clic sur "Enregistrer".
app.patch("/api/isolements/:id/solution-lc", async (req, res) => {
  let isolationId = Number(req.params.id);
  if (!isolationId) return res.status(400).json({ error: "id invalide" });

  let body = req.body || {};
  let source = body.solution_lc && typeof body.solution_lc === "object" ? body.solution_lc : body;

  let nom = String(source.nom || "").trim();
  let preparedOn = String(source.prepared_on || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const status = String(source.status || "pret").trim();
  let volumeInitialL = Number(source.volume_initial_l ?? source.volume_l ?? source.litres);
  let volumeRemainingL = Number(source.volume_remaining_l ?? source.volume_dispo_l ?? source.litres_dispo ?? volumeInitialL);
  let composants = Array.isArray(source.composants) ? source.composants : [];

  if (!nom) return res.status(400).json({ error: "nom obligatoire" });
  if (!Number.isFinite(volumeInitialL) || volumeInitialL <= 0) {
    return res.status(400).json({ error: "volume_initial_l invalide" });
  }
  if (!Number.isFinite(volumeRemainingL) || volumeRemainingL < 0) {
    return res.status(400).json({ error: "volume_remaining_l invalide" });
  }
  if (!composants.length) {
    return res.status(400).json({ error: "Au moins un composant requis" });
  }

  let normalizedComposants = composants
    .map((c) => ({
      nom: c && c.nom ? String(c.nom).trim() : "",
      g_par_l: c && (c.g_par_l ?? c.qte_par_l ?? c.g) !== undefined ? Number(c.g_par_l ?? c.qte_par_l ?? c.g) : null,
    }))
    .filter((c) => c.nom && Number.isFinite(c.g_par_l));

  if (!normalizedComposants.length) {
    return res.status(400).json({ error: "Composants invalides" });
  }

  let payloadJson = {
    nom,
    prepared_on: preparedOn,
    status,
    volume_initial_l: volumeInitialL,
    volume_remaining_l: volumeRemainingL,
    volume_l: volumeInitialL,
    composants: normalizedComposants,
    updated_at: new Date().toISOString(),
  };

  let client = await pool.connect();
  try {
    await client.query("BEGIN");

    let isoCheck = await client.query("SELECT id FROM isolements WHERE id=$1", [isolationId]);
    if (!isoCheck.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Isolement introuvable" });
    }

    // Stock disponible utilisé par les pages LC : volume_final_ml = quantité disponible actuelle.
    let solRes = await client.query(
      `INSERT INTO solution_nutritive (isolation_id, nom, volume_final_ml, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, isolation_id, nom, volume_final_ml, notes, created_at`,
      [isolationId, nom, Math.round(volumeRemainingL * 1000), `Préparée le ${preparedOn} - statut: ${status} - volume initial: ${volumeInitialL} L`]
    );
    let solutionId = solRes.rows[0].id;

    for (let i = 0; i < normalizedComposants.length; i++) {
      let c = normalizedComposants[i];
      await client.query(
        `INSERT INTO solution_nutritive_ligne
         (solution_id, ingredient, quantite, unite, ordre)
         VALUES ($1, $2, $3, $4, $5)`,
        [solutionId, c.nom, c.g_par_l, "g/L", i + 1]
      );
    }

    let upd = await client.query(
      "UPDATE isolements SET solution_lc=$1, updated_at=NOW() WHERE id=$2 RETURNING id, solution_lc",
      [JSON.stringify(payloadJson), isolationId]
    );

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Recette solution nutritive enregistrée",
      solution_id: solutionId,
      solution: solRes.rows[0],
      isolement: upd.rows[0],
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/isolements/:id/solution-lc error:", e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PATCH /api/isolements/:id/solution-nutritive
// Enregistre une recette de solution nutritive liée à l'isolement (persistée en DB)
// NOTE: on met aussi à jour isolements.solution_lc (JSON) pour compatibilité avec l'UI actuelle.
app.patch("/api/isolements/:id/solution-nutritive", async (req, res) => {
  const isolationId = Number(req.params.id);
  if (!isolationId) return res.status(400).json({ error: "id invalide" });

  const b = req.body || {};
  const nom = String(b.nom || "").trim();
  let litres = Number(b.volume_initial_l ?? b.volume_l ?? b.litres);

  const composants = Array.isArray(b.composants) ? b.composants : [];
  if (!nom) return res.status(400).json({ error: "nom obligatoire" });
  if (!Number.isFinite(litres) || litres <= 0) {
    return res.status(400).json({ error: "volume_initial_l invalide" });
  }
  if (!composants.length) {
    return res.status(400).json({ error: "Au moins un composant requis" });
  }

  // payload JSON attendu par le front (récap actuel)
  const payloadJson = {
    nom,
    volume_l: litres,
    composants: composants
      .map((c) => ({
        nom: c && c.nom ? String(c.nom).trim() : "",
        g_par_l: c && (c.g_par_l ?? c.g) !== undefined ? Number(c.g_par_l ?? c.g) : null,
      }))
      .filter((c) => c.nom && Number.isFinite(c.g_par_l)),
    updated_at: new Date().toISOString(),
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // vérifier isolement existe
    const isoCheck = await client.query("SELECT id FROM isolements WHERE id=$1", [isolationId]);
    if (!isoCheck.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Isolement introuvable" });
    }

    // 1) Insert entête solution
    const solRes = await client.query(
      `INSERT INTO solution_nutritive (isolation_id, nom, volume_final_ml, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [isolationId, nom, Math.round(litres * 1000), null]
    );
    const solutionId = solRes.rows[0].id;

    // 2) Insert lignes recette
    for (let i = 0; i < payloadJson.composants.length; i++) {
      const c = payloadJson.composants[i];
      await client.query(
        `INSERT INTO solution_nutritive_ligne
         (solution_id, ingredient, quantite, unite, ordre)
         VALUES ($1, $2, $3, $4, $5)`,
        [solutionId, c.nom, c.g_par_l, "g/L", i + 1]
      );
    }

    // 3) Compat UI: update JSON snapshot on isolement
    const upd = await client.query(
      "UPDATE isolements SET solution_lc=$1, updated_at=NOW() WHERE id=$2 RETURNING id, solution_lc",
      [JSON.stringify(payloadJson), isolationId]
    );

    await client.query("COMMIT");
    return res.json({ ...upd.rows[0], solution_id: solutionId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/isolements/:id/solution-nutritive error:", e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/isolements/:id/solutions-nutritives
// Retourne toutes les solutions nutritives liées à une isolation (avec leurs composants)
app.get("/api/isolements/:id/solutions-nutritives", async (req, res) => {
  try {
    const isolationId = Number(req.params.id);
    if (!isolationId) return res.status(400).json({ error: "id invalide" });

    // entêtes
    let solsRes = await pool.query(
      `SELECT id, isolation_id, nom, volume_final_ml, notes, created_at
       FROM solution_nutritive
       WHERE isolation_id=$1
       ORDER BY created_at DESC, id DESC`,
      [isolationId]
    );
    let sols = solsRes.rows || [];
    if (!sols.length) return res.json([]);

    // lignes
    let ids = sols.map((s) => s.id);
    let linesRes = await pool.query(
      `SELECT solution_id, ingredient, quantite, unite, ordre
       FROM solution_nutritive_ligne
       WHERE solution_id = ANY($1)
       ORDER BY solution_id, ordre ASC, id ASC`,
      [ids]
    );
    let bySol = {};
    (linesRes.rows || []).forEach((l) => {
      if (!bySol[l.solution_id]) bySol[l.solution_id] = [];
      bySol[l.solution_id].push(l);
    });

    let out = sols.map((s) => {
      let volL = s.volume_final_ml ? Number(s.volume_final_ml) / 1000 : null;
      const composants = (bySol[s.id] || []).map((l) => ({
        nom: l.ingredient,
        g_par_l: l.quantite,
        unite: l.unite,
      }));
      return {
        id: s.id,
        nom: s.nom,
        volume_l: volL,
        volume_initial_l: volL, // compat
        composants,
        created_at: s.created_at,
        notes: s.notes,
      };
    });
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /api/isolements/:id
// Supprime une isolation ET tous ses composants liés (Pétri, géloses, solutions, journaux, photos...)
app.delete("/api/isolements/:id", async (req, res) => {
  const isolationId = Number(req.params.id);
  if (!isolationId) return res.status(400).json({ error: "id invalide" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const isoCheck = await client.query("SELECT id, code FROM isolements WHERE id=$1", [isolationId]);
    if (!isoCheck.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Isolement introuvable" });
    }

    // 1) Pétris (réf geloses)
    await client.query("DELETE FROM iso_petris WHERE isolement_id=$1", [isolationId]);

    // 2) Journaux / checklists / photos
    await client.query("DELETE FROM isolement_journal_photos WHERE isolement_id=$1", [isolationId]);
    await client.query("DELETE FROM isolement_checklist_logs WHERE isolement_id=$1", [isolationId]);
    await client.query("DELETE FROM isolement_journal_days WHERE isolement_id=$1", [isolationId]);
    await client.query("DELETE FROM isolement_journal WHERE isolement_id=$1", [isolationId]);

    // 3) Géloses
    await client.query("DELETE FROM iso_geloses WHERE isolement_id=$1", [isolationId]);

    // 4) Solutions nutritives + lignes
    let solIdsRes = await client.query(
      "SELECT id FROM solution_nutritive WHERE isolation_id=$1",
      [isolationId]
    );
    let solIds = (solIdsRes.rows || []).map((r) => r.id);
    if (solIds.length) {
      await client.query("DELETE FROM solution_nutritive_ligne WHERE solution_id = ANY($1)", [solIds]);
      await client.query("DELETE FROM solution_nutritive WHERE id = ANY($1)", [solIds]);
    }

    // 5) Enfin l'isolement
    await client.query("DELETE FROM isolements WHERE id=$1", [isolationId]);

    await client.query("COMMIT");
    return res.json({ ok: true, deleted_id: isolationId });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.patch("/api/isolements/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { statut } = req.body || {};
    let newStatus = String(statut || "").toUpperCase();

    if (!id || !newStatus) return res.status(400).json({ error: "id et statut obligatoires" });

    let cur = await pool.query("SELECT id, statut FROM isolements WHERE id=$1", [id]);
    if (!cur.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    let oldStatus = String(cur.rows[0].statut || "").toUpperCase();

    let allowed = new Set([
      "EN_PREPARATION->EN_INCUBATION",
      "EN_INCUBATION->PRETE",
      "PRETE->PERIMEE",
      "EN_INCUBATION->PERIMEE",
      "PERIMEE->A_DETRUIRE",
      "A_DETRUIRE->ARCHIVEE",
    ]);

    let key = `${oldStatus}->${newStatus}`;
    if (!allowed.has(key) && oldStatus !== newStatus) {
      return res.status(400).json({ error: `Transition refusÃ©e: ${key}` });
    }

    const r = await pool.query(
      "UPDATE isolements SET statut=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [newStatus, id]
    );

    let updated = r.rows[0];
    res.json({ ...updated, ...computeIsoState(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================================================
// ISOLEMENT JOURNAL â€” TODAY (auto-create or read)
// GET /api/isolements/:id/journal/today
// ==================================================
app.get("/api/isolements/:id/journal/today", async (req, res) => {
  try {
    let isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id invalide" });

    let isoRes = await pool.query(
      `SELECT id, code, champignon, cycle_type, categorie, origine, infos,
              agar, date_prepa, date_prelev, date_exp, operateur,
              solution_lc, statut, global_status, created_at, updated_at
       FROM isolements
       WHERE id = $1
       LIMIT 1`,
      [isolementId]
    );
    if (!isoRes.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    const iso = isoRes.rows[0];
    let state = computeIsoState(iso);

    if (state.j_plus === null || state.j_plus === undefined) {
      return res.status(400).json({
        error: "Impossible de calculer j_plus (date_prelev invalide/non interprÃ©table).",
        date_prelev: iso.date_prelev,
      });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let journalDate = ymd(today);

    let jRes = await pool.query(
      `SELECT *
       FROM isolement_journal
       WHERE isolement_id = $1 AND journal_date = $2
       LIMIT 1`,
      [isolementId, journalDate]
    );

    if (jRes.rows.length) {
      return res.json({
        isolement: { id: iso.id, code: iso.code, champignon: iso.champignon, cycle_type: iso.cycle_type },
        ...state,
        journal: jRes.rows[0],
      });
    }

    let createdRes = await pool.query(
      `INSERT INTO isolement_journal
        (isolement_id, journal_date, j_plus, step_index, step_name, instruction,
         remarque_operateur, action_realisee, statut_confirme)
       VALUES
        ($1,$2,$3,$4,$5,$6,'','','')
       RETURNING *`,
      [isolementId, journalDate, state.j_plus, state.step_index, state.step_name, state.instruction_today]
    );

    res.json({
      isolement: { id: iso.id, code: iso.code, champignon: iso.champignon, cycle_type: iso.cycle_type },
      ...state,
      journal: createdRes.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================================================
// ISOLEMENT JOURNAL â€” WINDOW (N days), saved to DB
// GET /api/isolements/:id/journal?days=30
// ==================================================
app.get("/api/isolements/:id/journal", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id invalide" });

    let days = Math.max(1, Math.min(120, Number(req.query.days || 30)));

    const isoRes = await pool.query(
      `SELECT id, code, champignon, cycle_type, date_prelev, date_exp
       FROM isolements
       WHERE id = $1
       LIMIT 1`,
      [isolementId]
    );
    if (!isoRes.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    const iso = isoRes.rows[0];

    const prelev = parseYMD(iso.date_prelev);
    if (!prelev) {
      return res.status(400).json({
        error: "date_prelev manquante ou invalide â€” impossible de gÃ©nÃ©rer le journal.",
        date_prelev: iso.date_prelev,
      });
    }

    const exp = parseYMD(iso.date_exp);

    const now = new Date();
    let end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start = new Date(end);
    start.setDate(start.getDate() - (days - 1));

    let existingRes = await pool.query(
      `SELECT *
       FROM isolement_journal
       WHERE isolement_id = $1
         AND journal_date BETWEEN $2 AND $3
       ORDER BY journal_date ASC`,
      [isolementId, ymd(start), ymd(end)]
    );

    let existingByDate = new Map();
    existingRes.rows.forEach((r) => {
      const key = ymd(parseYMD(r.journal_date));
      if (key) existingByDate.set(key, r);
    });

    const cycle = String(iso.cycle_type || "").trim().toUpperCase();
    const rules = CYCLE_RULES[cycle] || CYCLE_RULES.PLEUROTUS;

    let toInsert = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      let dYMD = ymd(d);

      if (existingByDate.has(dYMD)) continue;

      const j = diffDays(prelev, d);
      let step_index;
      let step_name;
      let instruction;

      if (exp && diffDays(exp, d) > 0) {
        step_index = 6;
        step_name = "Fin de vie";
        instruction = "Date dâ€™expiration dÃ©passÃ©e : passer Ã  A_DETRUIRE puis ARCHIVEE.";
      } else {
        let step = rules.find((s) => j >= s.jMin && j <= s.jMax) || rules[rules.length - 1];
        step_index = step.step;
        step_name = step.name;
        instruction = step.instruction;
      }

      toInsert.push({ isolement_id: isolementId, journal_date: dYMD, j_plus: j, step_index, step_name, instruction });
    }

    if (toInsert.length) {
      let values = [];
      const params = [];
      let k = 1;

      for (const row of toInsert) {
        values.push(`($${k++}, $${k++}, $${k++}, $${k++}, $${k++}, $${k++}, '', '', '')`);
        params.push(row.isolement_id, row.journal_date, row.j_plus, row.step_index, row.step_name, row.instruction);
      }

      await pool.query(
        `INSERT INTO isolement_journal
          (isolement_id, journal_date, j_plus, step_index, step_name, instruction,
           remarque_operateur, action_realisee, statut_confirme)
         VALUES ${values.join(", ")}`,
        params
      );
    }

    let outRes = await pool.query(
      `SELECT *
       FROM isolement_journal
       WHERE isolement_id = $1
         AND journal_date BETWEEN $2 AND $3
       ORDER BY journal_date ASC`,
      [isolementId, ymd(start), ymd(end)]
    );

    res.json({
      isolement: { id: iso.id, code: iso.code, champignon: iso.champignon, cycle_type: iso.cycle_type },
      range: { start: ymd(start), end: ymd(end), days },
      rows: outRes.rows,
    });
  } catch (e) {
    console.error("GET /api/isolements/:id/journal", e);
    res.status(500).json({ error: e.message });
  }
});

// ==================================================
// PATCH /api/isolement-journal/:id
// ==================================================
app.patch("/api/isolement-journal/:id", async (req, res) => {
  try {
    let journalId = Number(req.params.id);
    if (!journalId) return res.status(400).json({ error: "id journal invalide" });

    const { remarque_operateur = "", action_realisee = "", statut_confirme = "" } = req.body || {};

    const upd = await pool.query(
      `UPDATE isolement_journal
       SET remarque_operateur = $1,
           action_realisee = $2,
           statut_confirme = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [String(remarque_operateur || ""), String(action_realisee || ""), String(statut_confirme || ""), journalId]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Journal introuvable" });
    res.json(upd.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// (Optionnel) GET /api/isolement-journal/:id
app.get("/api/isolement-journal/:id", async (req, res) => {
  try {
    const journalId = Number(req.params.id);
    if (!journalId) return res.status(400).json({ error: "id journal invalide" });

    const r = await pool.query(`SELECT * FROM isolement_journal WHERE id=$1 LIMIT 1`, [journalId]);
    if (!r.rows.length) return res.status(404).json({ error: "Journal introuvable" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================================================
// ISOLEMENT JOURNAL â€” UPDATE (ancienne route conservÃ©e)
// PATCH /api/isolements/:id/journal/:journalId
// ==================================================
app.patch("/api/isolements/:id/journal/:journalId", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    const journalId = Number(req.params.journalId);
    if (!isolementId || !journalId) {
      return res.status(400).json({ error: "id isolement / journal invalides" });
    }

    const { remarque_operateur = "", action_realisee = "", statut_confirme = "" } = req.body || {};

    const cur = await pool.query(
      `SELECT id, isolement_id
       FROM isolement_journal
       WHERE id = $1
       LIMIT 1`,
      [journalId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: "Journal introuvable" });
    if (Number(cur.rows[0].isolement_id) !== isolementId) {
      return res.status(400).json({ error: "Journal n'appartient pas Ã  cet isolement" });
    }

    const upd = await pool.query(
      `UPDATE isolement_journal
       SET remarque_operateur = $1,
           action_realisee = $2,
           statut_confirme = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [String(remarque_operateur || ""), String(action_realisee || ""), String(statut_confirme || ""), journalId]
    );

    res.json(upd.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =======================
// âœ… CYCLE BIOLOGIQUE (CHECKLIST + PHOTOS + SAVE)
// Tables:
// - isolement_journal_days
// - isolement_checklist_catalog
// - isolement_checklist_logs
// - isolement_journal_photos
// + isolements.global_status
// =======================

// âœ… GET /api/isolements/:id/cycle?days=30&day=YYYY-MM-DD
app.get("/api/isolements/:id/cycle", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id invalide" });

    const days = Math.max(1, Math.min(60, Number(req.query.days || 30)));
    let requestedDay = String(req.query.day || "").slice(0, 10);

    const isoRes = await pool.query(
      `SELECT id, code, champignon, cycle_type, date_prelev, global_status, statut
       FROM isolements
       WHERE id=$1
       LIMIT 1`,
      [isolementId]
    );
    if (!isoRes.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    const iso = isoRes.rows[0];
    let cycleType = String(iso.cycle_type || "PLEUROTUS").toUpperCase();

    let j0 = parseYMD(iso.date_prelev);
    if (!j0) return res.status(400).json({ error: "date_prelev (J0) invalide ou manquante" });

    const start = new Date(j0);
    const end = new Date(j0);
    end.setDate(end.getDate() + (days - 1));

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let todayStr = ymd(today);

    let daysRes = await pool.query(
      `SELECT isolement_id, journal_date, day_index, observation
       FROM isolement_journal_days
       WHERE isolement_id=$1 AND journal_date BETWEEN $2 AND $3
       ORDER BY journal_date ASC`,
      [isolementId, ymd(start), ymd(end)]
    );

    let byDate = new Map();
    for (const r of daysRes.rows) {
      const d = parseYMD(r.journal_date);
      if (!d) continue;
      byDate.set(ymd(d), r);
    }

    let outDays = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(j0);
      d.setDate(d.getDate() + i);
      let dStr = ymd(d);

      const existing = byDate.get(dStr);
      let locked = dStr !== todayStr;

      outDays.push({
        journal_date: dStr,
        day_index: i,
        observation: existing ? (existing.observation || "") : "",
        locked,
      });
    }

    let inWindow = (dStr) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dStr)) return false;
      const dt = parseYMD(dStr);
      if (!dt) return false;
      return dt.getTime() >= start.getTime() && dt.getTime() <= end.getTime();
    };

    let activeDate = null;
    if (requestedDay && inWindow(requestedDay)) {
      activeDate = requestedDay;
    } else {
      let todayIndex = diffDays(j0, today);
      activeDate = todayIndex >= 0 && todayIndex < days ? todayStr : outDays[0]?.journal_date;
    }

    let activeDayIndex = outDays.find((x) => x.journal_date === activeDate)?.day_index ?? 0;

    let itemsRes = await pool.query(
      `SELECT c.id AS catalog_item_id, c.label, c.is_critical, c.photo_required, c.sort_order,
              COALESCE(l.checked, FALSE) AS checked,
              COALESCE(l.remark, '') AS remark
       FROM isolement_checklist_catalog c
       LEFT JOIN isolement_checklist_logs l
         ON l.catalog_item_id = c.id
        AND l.isolement_id = $1
        AND l.journal_date = $2
       WHERE c.species = $3 AND c.day_index = $4 AND c.is_active = TRUE
       ORDER BY c.sort_order ASC, c.id ASC`,
      [isolementId, activeDate, cycleType, activeDayIndex]
    );

    let photosRes = await pool.query(
      `SELECT id, journal_date, catalog_item_id, file_url, caption, created_at
       FROM isolement_journal_photos
       WHERE isolement_id=$1 AND journal_date=$2
       ORDER BY created_at ASC`,
      [isolementId, activeDate]
    );

    res.json({
      isolement: {
        id: iso.id,
        code: iso.code,
        champignon: iso.champignon,
        cycle_type: cycleType,
        statut: iso.statut,
        global_status: iso.global_status || "",
        j0: ymd(j0),
      },
      range: { start: ymd(start), end: ymd(end), days },
      active: { journal_date: activeDate, day_index: activeDayIndex, locked: activeDate !== todayStr },
      days: outDays,
      checklist_items: itemsRes.rows,
      photos: photosRes.rows,
      today: todayStr,
    });
  } catch (e) {
    console.error("GET /api/isolements/:id/cycle", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/isolements/:id/cycle/save
app.post("/api/isolements/:id/cycle/save", async (req, res) => {
  const client = await pool.connect();
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id invalide" });

    const { journal_date, observation = "", items = [], global_status = "" } = req.body || {};
    let jd = String(journal_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jd)) {
      return res.status(400).json({ error: "journal_date invalide (YYYY-MM-DD)" });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStr = ymd(today);
    if (jd !== todayStr) return res.status(400).json({ error: "Seul le jour courant est modifiable." });

    const isoRes = await client.query(`SELECT id, date_prelev FROM isolements WHERE id=$1 LIMIT 1`, [isolementId]);
    if (!isoRes.rows.length) return res.status(404).json({ error: "Isolement introuvable" });

    const j0 = parseYMD(isoRes.rows[0].date_prelev);
    if (!j0) return res.status(400).json({ error: "date_prelev (J0) invalide" });

    let jdDate = parseYMD(jd);
    if (!jdDate) return res.status(400).json({ error: "journal_date invalide (parse)" });

    let dayIndex = diffDays(j0, jdDate);
    if (dayIndex < 0) return res.status(400).json({ error: "journal_date < J0 (interdit)" });

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO isolement_journal_days (isolement_id, journal_date, day_index, observation, locked)
       VALUES ($1,$2,$3,$4,FALSE)
       ON CONFLICT (isolement_id, journal_date)
       DO UPDATE SET observation = EXCLUDED.observation, day_index = EXCLUDED.day_index, updated_at = NOW()`,
      [isolementId, jd, dayIndex, String(observation || "")]
    );

    if (Array.isArray(items)) {
      for (const it of items) {
        let cid = Number(it.catalog_item_id);
        if (!cid) continue;
        await client.query(
          `INSERT INTO isolement_checklist_logs (isolement_id, journal_date, catalog_item_id, checked, remark)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (isolement_id, journal_date, catalog_item_id)
           DO UPDATE SET checked = EXCLUDED.checked, remark = EXCLUDED.remark, updated_at = NOW()`,
          [isolementId, jd, cid, Boolean(it.checked), String(it.remark || "")]
        );
      }
    }

    if (String(global_status || "").trim()) {
      await client.query(
        `UPDATE isolements SET global_status=$1, updated_at=NOW() WHERE id=$2`,
        [String(global_status).trim().toUpperCase(), isolementId]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, journal_date: jd });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/isolements/:id/cycle/save", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/isolements/:id/cycle/upload-photo
app.post("/api/isolements/:id/cycle/upload-photo", upload.single("file"), async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id invalide" });

    let journal_date = String(req.body.journal_date || "").slice(0, 10);
    let caption = String(req.body.caption || "");
    let catalog_item_id = req.body.catalog_item_id ? Number(req.body.catalog_item_id) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(journal_date)) {
      return res.status(400).json({ error: "journal_date invalide (YYYY-MM-DD)" });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStr = ymd(today);
    if (journal_date !== todayStr) {
      return res.status(400).json({ error: "Upload autorisÃ© uniquement pour le jour courant." });
    }

    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });

    let file_url = await persistUploadedFile({
      file: req.file,
      folder: "isolements",
      filename: req.file.filename || generatedUploadName(req, req.file, "ISOIMG"),
    });

    let ins = await pool.query(
      `INSERT INTO isolement_journal_photos
       (isolement_id, journal_date, catalog_item_id, file_url, caption)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [isolementId, journal_date, catalog_item_id, file_url, caption]
    );

    res.json(ins.rows[0]);
  } catch (e) {
    console.error("POST /api/isolements/:id/cycle/upload-photo", e);
    res.status(500).json({ error: e.message });
  }
});

// âœ… DELETE /api/isolements/:id/cycle/photo/:photoId   (pour bouton "Supprimer")
app.delete("/api/isolements/:id/cycle/photo/:photoId", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    let photoId = Number(req.params.photoId);
    if (!isolementId || !photoId) return res.status(400).json({ error: "ParamÃ¨tres invalides" });

    const r = await pool.query(
      `SELECT id, isolement_id, file_url
       FROM isolement_journal_photos
       WHERE id=$1
       LIMIT 1`,
      [photoId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Photo introuvable" });

    let photo = r.rows[0];
    if (Number(photo.isolement_id) !== isolementId) {
      return res.status(400).json({ error: "Photo n'appartient pas Ã  cet isolement" });
    }

    await pool.query(`DELETE FROM isolement_journal_photos WHERE id=$1`, [photoId]);

    // Supprime aussi le fichier Supabase Storage (ou le fichier local en developpement).
    await deleteStoredFile(photo.file_url, SITE_DIR);

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/isolements/:id/cycle/photo/:photoId", e);
    res.status(500).json({ error: e.message });
  }
});


// ===== LC SOLUTION LOTS (compatibilité ancienne UI, basée sur solution_nutritive) =====
// NOTE: ta base réelle n'a pas lc_solution_lots. On expose cette API en lecture/écriture
// via solution_nutritive + solution_nutritive_ligne pour éviter les erreurs de colonnes/table.
app.get("/api/lc-solution-lots", async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const isolationId = req.query.isolation_id ? Number(req.query.isolation_id) : null;
    let strainCode = String(req.query.strain_code || "").trim();

    const where = [];
    const params = [];
    if (isolationId) {
      params.push(isolationId);
      where.push(`sn.isolation_id = $${params.length}`);
    } else if (strainCode) {
      params.push(strainCode);
      where.push(`i.code = $${params.length}`);
    }

    const { rows } = await pool.query(`
      SELECT sn.id,
             sn.id AS solution_id,
             sn.isolation_id,
             sn.nom,
             sn.nom AS lot_code,
             i.code AS strain_code,
             sn.volume_final_ml,
             sn.volume_initial_ml,
             (sn.volume_final_ml::numeric / 1000.0) AS volume_remaining_l,
             (COALESCE(sn.volume_initial_ml, sn.volume_final_ml)::numeric / 1000.0) AS volume_initial_l,
             COALESCE(sn.status, 'pret') AS status,
             COALESCE(sn.prepared_on, sn.created_at::date) AS prepared_on,
             sn.type_champignon,
             sn.protocole,
             sn.notes,
             sn.created_at
      FROM solution_nutritive sn
      JOIN isolements i ON i.id = sn.isolation_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY sn.created_at DESC, sn.id DESC
    `, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/lc-solution-lots", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/lc-solution-lots", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureLcPotWorkflowSchema();
    const b = req.body || {};
    const isolationId = Number(b.isolation_id || b.parent_iso_id || 0);
    const strainCode = String(b.strain_code || b.parent_iso_code || "").trim();
    const nom = String(b.nom || b.lot_code || "Solution nutritive LC").trim();
    const volumeInitialL = Number(b.volume_initial_l || 0);
    const volumeRemainingL = Number(b.volume_remaining_l ?? b.volume_initial_l ?? 0);
    const preparedOn = String(b.prepared_on || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const status = String(b.status || "pret").trim();

    let isoId = isolationId;
    if (!isoId && strainCode) {
      const iso = await client.query(`SELECT id FROM isolements WHERE code=$1 LIMIT 1`, [strainCode]);
      isoId = Number(iso.rows[0]?.id || 0);
    }
    if (!isoId) return res.status(400).json({ error: "isolation_id ou strain_code obligatoire" });
    if (!nom) return res.status(400).json({ error: "nom/l lot_code obligatoire" });

    await client.query("BEGIN");
    const ins = await client.query(`
      INSERT INTO solution_nutritive
        (isolation_id, nom, volume_final_ml, volume_initial_ml, prepared_on, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, isolation_id, nom, volume_final_ml, volume_initial_ml, prepared_on, status, notes, created_at
    `, [isoId, nom, Math.round(volumeRemainingL * 1000), Math.round(volumeInitialL * 1000), preparedOn, status, String(b.notes || "")]);
    await client.query("COMMIT");
    res.status(201).json({ ...ins.rows[0], lot_code: ins.rows[0].nom });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("POST /api/lc-solution-lots", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post("/api/lc-solution-lots/consume", async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const { lot_code, solution_id, consume_l } = req.body || {};
    let consumeMl = Math.round(Number(consume_l || 0) * 1000);
    if ((!lot_code && !solution_id) || !consumeMl) {
      return res.status(400).json({ error: "lot_code/solution_id et consume_l sont obligatoires" });
    }
    const params = solution_id ? [Number(solution_id), consumeMl] : [String(lot_code), consumeMl];
    const where = solution_id ? "id=$1" : "nom=$1";
    const { rows } = await pool.query(`
      UPDATE solution_nutritive
      SET volume_final_ml = GREATEST(COALESCE(volume_final_ml, 0) - $2, 0)
      WHERE ${where}
      RETURNING id, nom, nom AS lot_code, volume_final_ml, volume_initial_ml, prepared_on, status
    `, params);
    if (!rows.length) return res.status(404).json({ error: "Solution nutritive introuvable" });
    res.json(rows[0]);
  } catch (e) {
    console.error("POST /api/lc-solution-lots/consume", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== LC LOTS (compatibilité avec la base réelle: lc_lots.code, j0_date, total_pots, volume_par_pot_ml) =====
app.get("/api/lc-lots", async (req, res) => {
  try {
    const strainCode = String(req.query.strain_code || "").trim();
    const params = [];
    const where = [];
    if (strainCode) {
      params.push(strainCode);
      where.push(`parent_iso_code = $${params.length}`);
    }
    const { rows } = await pool.query(`
      SELECT l.*,
             l.code AS lot_code,
             l.parent_iso_code AS strain_code,
             l.j0_date AS prepared_on,
             l.total_pots AS nb_pots,
             l.volume_par_pot_ml AS volume_ml_per_pot,
             l.volume_par_pot_ml AS inj_ml_per_pot,
             COALESCE(l.solution->>'nom', l.solution->>'solution_nom', '') AS solution_lot_code
      FROM lc_lots l
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(l.j0_date, l.created_at::date) DESC, l.id DESC
    `, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/lc-lots", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/lc-lots", async (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.code || b.lot_code || lcLotCode()).trim();
    let parentIsoId = Number(b.parent_iso_id || b.isolation_id || 0);
    let parentIsoCode = String(b.parent_iso_code || b.strain_code || "").trim();

    if (!parentIsoId && parentIsoCode) {
      const iso = await pool.query(`SELECT id, code, champignon, categorie, origine FROM isolements WHERE code=$1 LIMIT 1`, [parentIsoCode]);
      parentIsoId = Number(iso.rows[0]?.id || 0);
    }
    if (!parentIsoId) return res.status(400).json({ error: "parent_iso_id/isolation_id obligatoire" });

    const isoRes = await pool.query(`SELECT id, code, champignon, categorie, origine FROM isolements WHERE id=$1 LIMIT 1`, [parentIsoId]);
    if (!isoRes.rows.length) return res.status(404).json({ error: "Isolation introuvable" });
    const iso = isoRes.rows[0];
    parentIsoCode = parentIsoCode || iso.code;

    let totalPots = Number(b.total_pots || b.nb_pots || 6);
    let volumeParPotMl = Number(b.volume_par_pot_ml || b.volume_ml_per_pot || b.inj_ml_per_pot || 700);
    let j0Date = String(b.j0_date || b.prepared_on || new Date().toISOString().slice(0, 10)).slice(0, 10);
    let solution = b.solution && typeof b.solution === "object" ? b.solution : {
      nom: String(b.solution_lot_code || ""),
      solution_lot_code: String(b.solution_lot_code || "")
    };

    const { rows } = await pool.query(`
      INSERT INTO lc_lots
        (code, parent_iso_id, parent_iso_code, champignon, categorie, origine, solution,
         total_pots, volume_par_pot_ml, j0_date, j_actuel, cycle_status, source_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'EN_COURS',$11)
      RETURNING *
    `, [
      code,
      parentIsoId,
      parentIsoCode,
      String(b.champignon || iso.champignon || ""),
      String(b.categorie || iso.categorie || "LC"),
      String(b.origine || iso.origine || ""),
      JSON.stringify(solution),
      totalPots,
      volumeParPotMl,
      j0Date,
      String(b.source_type || "P3")
    ]);

    // Sécurité si le trigger auto_create_lc_pots n'est pas actif.
    for (let i = 1; i <= totalPots; i++) {
      await pool.query(`
        INSERT INTO lc_pots (lc_lot_id, pot_number, volume_ml, status)
        VALUES ($1,$2,$3,'ACTIF')
        ON CONFLICT (lc_lot_id, pot_number) DO NOTHING
      `, [rows[0].id, i, volumeParPotMl]);
    }

    res.status(201).json({
      ...rows[0],
      lot_code: rows[0].code,
      prepared_on: rows[0].j0_date,
      nb_pots: rows[0].total_pots,
      volume_ml_per_pot: rows[0].volume_par_pot_ml
    });
  } catch (e) {
    console.error("POST /api/lc-lots", e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// LC POT-A-POT depuis P3 piquable + solution nutritive associée
// Compatible avec la vraie base: lc_lots.code / parent_iso_id / volume_par_pot_ml / j0_date
// ============================================================
let lcPotWorkflowSchemaReady = false;
async function ensureLcPotWorkflowSchema() {
  if (lcPotWorkflowSchemaReady) return;

  // Colonnes légères ajoutées à lc_lots pour tracer le lien P3 -> solution -> lot LC.
  // On ne crée PAS lot_code/prepared_on/nb_pots: ta base utilise déjà code/j0_date/total_pots.
  await realPool.query(`ALTER TABLE lc_lots ADD COLUMN IF NOT EXISTS source_petri_id BIGINT`);
  await realPool.query(`ALTER TABLE lc_lots ADD COLUMN IF NOT EXISTS solution_id INTEGER`);
  await realPool.query(`ALTER TABLE lc_lots ADD COLUMN IF NOT EXISTS cycle_template TEXT DEFAULT 'GENERIC'`);

  // Colonnes nécessaires pour passage des pots LC au stock à J18.
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS stock_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS stock_day_index INTEGER`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now()`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS code TEXT`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS volume_ml INTEGER DEFAULT 720`);
  await realPool.query(`UPDATE lc_pots SET volume_ml=720 WHERE volume_ml IS NULL OR volume_ml=0`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS agar_test_validated BOOLEAN DEFAULT FALSE`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS agar_test_validated_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS lc_validated BOOLEAN DEFAULT FALSE`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS lc_validated_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS validation_notes TEXT`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS fridge_stored BOOLEAN DEFAULT FALSE`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS fridge_stored_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS fridge_expiry_date DATE`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS fridge_storage_days INTEGER DEFAULT 60`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS fridge_label_printed_at TIMESTAMP`);
  await realPool.query(`ALTER TABLE lc_pots ADD COLUMN IF NOT EXISTS lc_created_date DATE`);
  await realPool.query(`UPDATE lc_pots p SET lc_created_date = COALESCE(p.lc_created_date, l.j0_date::date, CURRENT_DATE) FROM lc_lots l WHERE l.id=p.lc_lot_id`);
  await realPool.query(`ALTER TABLE lc_pots ALTER COLUMN fridge_storage_days SET DEFAULT 45`);
  await realPool.query(`UPDATE lc_pots p SET code = l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0') FROM lc_lots l WHERE l.id=p.lc_lot_id AND (p.code IS NULL OR p.code='')`);

  // Même recette accessible depuis Isolement et depuis LC.
  await realPool.query(`ALTER TABLE solution_nutritive ADD COLUMN IF NOT EXISTS type_champignon TEXT`);
  await realPool.query(`ALTER TABLE solution_nutritive ADD COLUMN IF NOT EXISTS protocole TEXT`);
  await realPool.query(`ALTER TABLE solution_nutritive ADD COLUMN IF NOT EXISTS volume_initial_ml NUMERIC`);
  await realPool.query(`ALTER TABLE solution_nutritive ADD COLUMN IF NOT EXISTS prepared_on DATE DEFAULT CURRENT_DATE`);
  await realPool.query(`ALTER TABLE solution_nutritive ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pret'`);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS lc_pot_journal (
      id SERIAL PRIMARY KEY,
      lc_lot_id BIGINT NOT NULL,
      lc_pot_id BIGINT NOT NULL,
      day_index INTEGER NOT NULL,
      manipulation_type TEXT,
      magnetic_mix_minutes NUMERIC DEFAULT 0,
      temperature_c NUMERIC,
      photo_url TEXT,
      reference_image_url TEXT,
      note20 NUMERIC DEFAULT 10,
      observations TEXT,
      lab_color TEXT DEFAULT 'NORMAL',
      lab_density TEXT DEFAULT 'MOYENNE',
      lab_homogeneity TEXT DEFAULT 'HOMOGENE',
      lab_odor TEXT DEFAULT 'NON_TESTEE',
      lab_contamination TEXT DEFAULT 'AUCUNE',
      lab_conclusion TEXT DEFAULT 'SAIN',
      check_mix_done BOOLEAN DEFAULT FALSE,
      check_temp_ok BOOLEAN DEFAULT FALSE,
      check_photo_done BOOLEAN DEFAULT FALSE,
      check_reference_compared BOOLEAN DEFAULT FALSE,
      treated_at TIMESTAMP DEFAULT now(),
      operator_name TEXT
    )
  `);
  await realPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lc_pot_journal_day ON lc_pot_journal(lc_pot_id, day_index)`);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS lc_reference_day_images (
      id SERIAL PRIMARY KEY,
      lc_lot_id BIGINT NOT NULL,
      day_index INTEGER NOT NULL,
      lc_pot_id BIGINT,
      journal_id INTEGER,
      file_url TEXT NOT NULL,
      note20 NUMERIC DEFAULT 10,
      commentaire TEXT,
      updated_at TIMESTAMP DEFAULT now()
    )
  `);
  await realPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lc_reference_lot_day ON lc_reference_day_images(lc_lot_id, day_index)`);

  lcPotWorkflowSchemaReady = true;
}

function lcTemplateFromCycle(cycleType, champignon) {
  let s = `${cycleType || ''} ${champignon || ''}`.toUpperCase();
  if (s.includes('PLEUROT')) return 'PLEUROTE';
  if (s.includes('AGARIC')) return 'AGARICUS';
  return 'GENERIC';
}

function lcLotCode() { return genCode('LC'); }
function lcPotCode(lotCode, n) { return `${lotCode}-POT-${String(n).padStart(2, '0')}`; }

function lcIncubationPhase(day) {
  const d = Number(day || 0);
  if (d <= 0) return 'INOCULATION';
  if (d <= 2) return 'ADAPTATION';
  if (d <= 4) return 'DEBUT_CROISSANCE';
  if (d <= 10) return 'CROISSANCE_ACTIVE';
  if (d <= 13) return 'STABILISATION';
  if (d === 14) return 'CONTROLE_QUALITE';
  if (d <= 17) return 'OPTIMAL';
  return 'STOCK';
}

async function lcLotWithComputedFields(lotId) {
  await ensureLcPotWorkflowSchema();
  const r = await pool.query(`
    SELECT l.*,
           i.code AS iso_code, i.champignon AS iso_champignon, i.origine AS iso_origine, i.cycle_type,
           p.phase AS source_phase, p.status AS source_status,
           sn.nom AS solution_nom, sn.volume_final_ml AS solution_volume_ml,
           (SELECT COUNT(*)::int FROM lc_pots pp WHERE pp.lc_lot_id=l.id AND pp.deleted_at IS NULL) AS pots_count
    FROM lc_lots l
    LEFT JOIN isolements i ON i.id = l.parent_iso_id
    LEFT JOIN iso_petris p ON p.id = l.source_petri_id
    LEFT JOIN solution_nutritive sn ON sn.id = l.solution_id
    WHERE l.id=$1
    LIMIT 1`, [lotId]);
  if (!r.rows.length) return null;
  let lot = r.rows[0];
  const j0 = parseYMD(lot.j0_date);
  const today = new Date();
  let cleanToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let jour = j0 ? Math.max(0, diffDays(j0, cleanToday)) : 0;
  let solutionFromJson = lot.solution && typeof lot.solution === 'object' ? lot.solution : {};
  let solutionName = lot.solution_nom || solutionFromJson.nom || solutionFromJson.solution_nom || solutionFromJson.solution_lot_code || '';
  return {
    ...lot,
    code: lot.code,
    lot_code: lot.code,
    parent_iso_id: lot.parent_iso_id,
    isolation_id: lot.parent_iso_id,
    champignon: lot.champignon || lot.iso_champignon || '',
    origine: lot.origine || lot.iso_origine || '',
    j0_date: lot.j0_date,
    prepared_on: lot.j0_date,
    jour_actuel: jour,
    incubation_phase: lcIncubationPhase(jour),
    display_status: jour >= 18 ? 'STOCK' : (lot.cycle_status || 'EN_COURS'),
    total_pots_crees: Number(lot.total_pots || lot.pots_count || 0),
    nb_pots: Number(lot.total_pots || lot.pots_count || 0),
    pots_disponibles: Number(lot.pots_count || 0),
    volume_ml_per_pot: Number(lot.volume_par_pot_ml || 0),
    volume_par_pot_ml: Number(lot.volume_par_pot_ml || 0),
    solution_lot_code: solutionName,
    solution: solutionName ? { id: lot.solution_id, nom: solutionName, volume_final_ml: lot.solution_volume_ml } : null,
    certification_status: lot.certification_status || 'NON_CERTIFIE',
    cycle_template: lot.cycle_template || lcTemplateFromCycle(lot.cycle_type, lot.champignon || lot.iso_champignon)
  };
}

// Historique des P3 transférables vers LC : P3 + dernier journal piquable actif.
app.get('/api/lc-workflow/p3-ready', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const r = await pool.query(`
      WITH last_j AS (
        SELECT DISTINCT ON (petri_id)
          petri_id, day_index, is_pickable, choices, image_url, visual_note20, treated_at
        FROM iso_petri_journal
        ORDER BY petri_id, day_index DESC, treated_at DESC, id DESC
      )
      SELECT p.id AS petri_id, p.isolement_id, p.phase, p.j0, p.status,
             i.code AS iso_code, i.champignon, i.origine, i.cycle_type,
             lj.day_index AS last_day, lj.image_url AS last_image_url, lj.visual_note20,
             COALESCE(lj.is_pickable, false) AS is_pickable,
             COALESCE((lj.choices->>'is_pickable')::boolean, false) AS choices_pickable,
             (SELECT COUNT(*)::int FROM solution_nutritive sn WHERE sn.isolation_id=i.id) AS solutions_count,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'id', sn.id,
                 'nom', sn.nom,
                 'volume_final_ml', sn.volume_final_ml
               ) ORDER BY sn.created_at DESC)
               FROM solution_nutritive sn
               WHERE sn.isolation_id=i.id
             ), '[]'::json) AS solutions_disponibles,
             EXISTS(SELECT 1 FROM lc_lots l WHERE l.source_petri_id=p.id) AS already_transferred
      FROM iso_petris p
      JOIN isolements i ON i.id=p.isolement_id
      LEFT JOIN last_j lj ON lj.petri_id=p.id
      WHERE p.phase=3
        AND p.deleted_at IS NULL
        AND (COALESCE(lj.is_pickable, false) = true OR COALESCE((lj.choices->>'is_pickable')::boolean, false) = true)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 300
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/lc-workflow/p3-ready', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lc-workflow/isolations/:id/solutions', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const isolationId = Number(req.params.id);
    if (!isolationId) return res.status(400).json({ error: 'id isolation invalide' });
    const r = await pool.query(`
      SELECT sn.id, sn.isolation_id, sn.nom, sn.volume_final_ml, sn.volume_initial_ml,
             sn.prepared_on, sn.status, sn.type_champignon, sn.protocole, sn.notes, sn.created_at,
             COALESCE(json_agg(json_build_object('ingredient', l.ingredient, 'quantite', l.quantite, 'unite', l.unite, 'ordre', l.ordre) ORDER BY l.ordre) FILTER (WHERE l.id IS NOT NULL), '[]') AS composants
      FROM solution_nutritive sn
      LEFT JOIN solution_nutritive_ligne l ON l.solution_id=sn.id
      WHERE sn.isolation_id=$1
      GROUP BY sn.id
      ORDER BY sn.created_at DESC
    `, [isolationId]);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/lc-workflow/isolations/:id/solutions', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/lc-workflow/isolations/:id/solutions', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureLcPotWorkflowSchema();
    const isolationId = Number(req.params.id);
    if (!isolationId) return res.status(400).json({ error: 'id isolation invalide' });

    const b = req.body || {};
    const nom = String(b.nom || '').trim();
    let typeChampignon = String(b.type_champignon || b.champignon || '').trim();
    let volumeInitialMl = Number(b.volume_initial_ml ?? b.volume_ml ?? b.volume_final_ml ?? 0);
    let volumeFinalMl = Number(b.volume_final_ml ?? b.volume_initial_ml ?? b.volume_ml ?? 0);
    const preparedOn = String(b.prepared_on || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const status = String(b.status || 'pret').trim();
    let protocole = String(b.protocole || '').trim();
    const composants = Array.isArray(b.composants) ? b.composants : [];

    if (!nom) return res.status(400).json({ error: 'Nom de la solution obligatoire' });
    if (!Number.isFinite(volumeFinalMl) || volumeFinalMl <= 0) return res.status(400).json({ error: 'Volume solution invalide' });
    if (!composants.length) return res.status(400).json({ error: 'Au moins un composant est obligatoire' });

    let normalized = composants
      .map((c) => ({
        ingredient: String(c.ingredient || c.nom || '').trim(),
        quantite: Number(c.quantite ?? c.g_par_l ?? c.qte_par_l ?? 0),
        unite: String(c.unite || 'g/L').trim()
      }))
      .filter((c) => c.ingredient && Number.isFinite(c.quantite));

    if (!normalized.length) return res.status(400).json({ error: 'Composants invalides' });

    await client.query('BEGIN');

    const isoCheck = await client.query('SELECT id, champignon, cycle_type FROM isolements WHERE id=$1 LIMIT 1', [isolationId]);
    if (!isoCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Isolation introuvable' });
    }

    let effectiveType = typeChampignon || isoCheck.rows[0].champignon || isoCheck.rows[0].cycle_type || '';
    let notes = String(b.notes || `Recette LC - ${effectiveType}`).trim();

    const solRes = await client.query(
      `INSERT INTO solution_nutritive
         (isolation_id, nom, volume_final_ml, volume_initial_ml, prepared_on, status, type_champignon, protocole, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, isolation_id, nom, volume_final_ml, volume_initial_ml, prepared_on, status, type_champignon, protocole, notes, created_at`,
      [isolationId, nom, Math.round(volumeFinalMl), Math.round(volumeInitialMl || volumeFinalMl), preparedOn, status, effectiveType, protocole, notes]
    );

    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      await client.query(
        `INSERT INTO solution_nutritive_ligne (solution_id, ingredient, quantite, unite, ordre)
         VALUES ($1,$2,$3,$4,$5)`,
        [solRes.rows[0].id, c.ingredient, c.quantite, c.unite, i + 1]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, solution: solRes.rows[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/lc-workflow/isolations/:id/solutions', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/lc-workflow/lots', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureLcPotWorkflowSchema();
    const b = req.body || {};
    let sourcePetriId = Number(b.source_petri_id);
    const solutionId = Number(b.solution_id);
    let nbPots = Number(b.nb_pots || b.total_pots || 0);
    let volumeMl = Number(b.volume_ml_per_pot || b.volume_par_pot_ml || b.volume_per_pot_ml || 0);
    if (!sourcePetriId || !solutionId || !nbPots || nbPots < 1 || !volumeMl || volumeMl <= 0) {
      return res.status(400).json({ error: 'source_petri_id, solution_id, nb_pots et volume_ml_per_pot obligatoires' });
    }

    await client.query('BEGIN');
    let srcRes = await client.query(`
      SELECT p.id, p.isolement_id, p.phase, p.status, i.code AS iso_code, i.champignon, i.categorie, i.origine, i.cycle_type,
             sn.id AS solution_id, sn.nom AS solution_nom, sn.volume_final_ml
      FROM iso_petris p
      JOIN isolements i ON i.id=p.isolement_id
      JOIN solution_nutritive sn ON sn.id=$2 AND sn.isolation_id=i.id
      WHERE p.id=$1 AND p.phase=3 AND p.deleted_at IS NULL
      LIMIT 1`, [sourcePetriId, solutionId]);
    if (!srcRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'P3 ou solution nutritive introuvable pour cette isolation' });
    }

    let lastObsRes = await client.query(`
      SELECT is_pickable, choices FROM iso_petri_journal WHERE petri_id=$1 ORDER BY day_index DESC, treated_at DESC, id DESC LIMIT 1
    `, [sourcePetriId]);
    let last = lastObsRes.rows[0] || {};
    let choicePickable = !!(last.choices && (last.choices.is_pickable || last.choices.mycelium_pickable));
    if (!last.is_pickable && !choicePickable) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Transfert refusé : le P3 doit être piquable actif dans le journal.' });
    }

    let src = srcRes.rows[0];
    let needMl = nbPots * volumeMl;
    if (Number(src.volume_final_ml || 0) < needMl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Solution insuffisante : besoin ${needMl} mL, disponible ${src.volume_final_ml || 0} mL.` });
    }

    const code = String(b.code || lcLotCode()).trim();
    const j0 = String(b.j0_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    let tpl = lcTemplateFromCycle(src.cycle_type, src.champignon);
    let solutionJson = {
      solution_id: solutionId,
      nom: src.solution_nom,
      utilise_ml: needMl,
      stock_avant_ml: Number(src.volume_final_ml || 0),
      stock_apres_ml: Math.max(Number(src.volume_final_ml || 0) - needMl, 0)
    };

    let lotRes = await client.query(`
      INSERT INTO lc_lots
        (code, parent_iso_id, parent_iso_code, champignon, categorie, origine, solution,
         total_pots, volume_par_pot_ml, j0_date, j_actuel, cycle_status, certification_status,
         source_type, source_petri_id, solution_id, cycle_template)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'EN_COURS','NON_CERTIFIE','P3',$11,$12,$13)
      RETURNING *
    `, [
      code,
      Number(src.isolement_id),
      src.iso_code,
      src.champignon,
      src.categorie || 'LC',
      src.origine || '',
      JSON.stringify(solutionJson),
      nbPots,
      volumeMl,
      j0,
      sourcePetriId,
      solutionId,
      tpl
    ]);

    await client.query(`UPDATE solution_nutritive SET volume_final_ml = GREATEST(COALESCE(volume_final_ml,0) - $2, 0) WHERE id=$1`, [solutionId, needMl]);
    for (let i = 1; i <= nbPots; i++) {
      await client.query(`
        INSERT INTO lc_pots(lc_lot_id, pot_number, volume_ml, status)
        VALUES ($1,$2,$3,'ACTIF')
        ON CONFLICT (lc_lot_id, pot_number) DO NOTHING
      `, [lotRes.rows[0].id, i, volumeMl]);
    }

    await client.query('COMMIT');
    res.status(201).json(await lcLotWithComputedFields(lotRes.rows[0].id));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/lc-workflow/lots', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/lc-workflow/lots', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const r = await pool.query(`
      SELECT l.id FROM lc_lots l
      WHERE l.source_petri_id IS NOT NULL OR l.parent_iso_id IS NOT NULL
      ORDER BY COALESCE(l.j0_date, l.created_at::date) DESC, l.id DESC
      LIMIT 300
    `);
    let rows = [];
    for (const x of r.rows) rows.push(await lcLotWithComputedFields(x.id));
    res.json(rows.filter(Boolean));
  } catch (e) {
    console.error('GET /api/lc-workflow/lots', e);
    res.status(500).json({ error: e.message });
  }
});


app.delete('/api/lc-workflow/lots/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureLcPotWorkflowSchema();
    let lotId = Number(req.params.id);
    if (!lotId) return res.status(400).json({ error: 'id lot LC invalide' });

    await client.query('BEGIN');

    const lotRes = await client.query(
      `SELECT id, code, solution_id, total_pots, volume_par_pot_ml
       FROM lc_lots
       WHERE id=$1
       LIMIT 1`,
      [lotId]
    );

    if (!lotRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lot LC introuvable' });
    }

    const lot = lotRes.rows[0];
    let restoreMl = Number(lot.total_pots || 0) * Number(lot.volume_par_pot_ml || 0);

    await client.query(`DELETE FROM lc_pot_journal WHERE lc_lot_id=$1`, [lotId]);
    await client.query(`DELETE FROM lc_reference_day_images WHERE lc_lot_id=$1`, [lotId]);
    await client.query(`DELETE FROM lc_pots WHERE lc_lot_id=$1`, [lotId]);
    await client.query(`DELETE FROM lc_lots WHERE id=$1`, [lotId]);

    if (lot.solution_id && restoreMl > 0) {
      await client.query(
        `UPDATE solution_nutritive
         SET volume_final_ml = COALESCE(volume_final_ml, 0) + $2
         WHERE id=$1`,
        [Number(lot.solution_id), restoreMl]
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, deleted_id: lotId, restored_solution_ml: restoreMl });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE /api/lc-workflow/lots/:id', e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/lc-workflow/lots/:id', async (req, res) => {
  try {
    const lot = await lcLotWithComputedFields(Number(req.params.id));
    if (!lot) return res.status(404).json({ error: 'Lot LC introuvable' });
    res.json(lot);
  } catch (e) {
    console.error('GET /api/lc-workflow/lots/:id', e);
    res.status(500).json({ error: e.message });
  }
});


// Route robuste : pots d'un lot LC + traitement journalier réalisé ou non
app.get('/api/lc-workflow/lots/:id/pots-status-today', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();

    const lotId = Number(req.params.id);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'id lot invalide' });
    }

    const result = await pool.query(`
      WITH lot AS (
        SELECT id, code, GREATEST(0, LEAST(18, CURRENT_DATE - COALESCE(j0_date, created_at::date)))::int AS jour_actuel
        FROM lc_lots
        WHERE id = $1
      ), today_journal AS (
        SELECT DISTINCT ON (j.lc_pot_id)
          j.lc_pot_id,
          j.id AS journal_today_id,
          j.day_index AS journal_today_day,
          j.treated_at AS today_treated_at
        FROM lc_pot_journal j
        JOIN lot l ON l.id = j.lc_lot_id
        WHERE j.day_index = l.jour_actuel
        ORDER BY j.lc_pot_id, j.treated_at DESC, j.id DESC
      ), last_journal AS (
        SELECT DISTINCT ON (j.lc_pot_id)
          j.lc_pot_id,
          j.day_index AS last_journal_day,
          j.treated_at AS last_treated_at
        FROM lc_pot_journal j
        JOIN lot l ON l.id = j.lc_lot_id
        ORDER BY j.lc_pot_id, j.day_index DESC, j.treated_at DESC, j.id DESC
      )
      SELECT
        p.*,
        (l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0')) AS code,
        l.jour_actuel,
        (tj.journal_today_id IS NOT NULL) AS today_treated,
        (tj.journal_today_id IS NOT NULL) AS treated_today,
        (tj.journal_today_id IS NOT NULL) AS done_today,
        tj.journal_today_id,
        tj.journal_today_day,
        tj.today_treated_at,
        lj.last_journal_day,
        lj.last_treated_at
      FROM lc_pots p
      JOIN lot l ON l.id = p.lc_lot_id
      LEFT JOIN today_journal tj ON tj.lc_pot_id = p.id
      LEFT JOIN last_journal lj ON lj.lc_pot_id = p.id
      WHERE p.deleted_at IS NULL
      ORDER BY p.pot_number ASC, p.id ASC
    `, [lotId]);

    if (!result.rows.length) {
      const exists = await pool.query('SELECT id FROM lc_lots WHERE id=$1', [lotId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'Lot LC introuvable' });
    }

    res.json(result.rows);
  } catch (e) {
    console.error('pots-status-today', e);
    res.status(500).json({ error: e.message || 'Erreur pots LC' });
  }
});

// Suppression pot LC
app.delete('/api/lc-workflow/pots/:id', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    let potId = Number(req.params.id);
    if (!potId) return res.status(400).json({ error: 'id pot invalide' });

    await pool.query(`DELETE FROM lc_pot_journal WHERE lc_pot_id=$1`, [potId]).catch(()=>{});
    await pool.query(`DELETE FROM lc_pots WHERE id=$1`, [potId]);

    res.json({ ok:true, deleted_id: potId });
  } catch (e) {
    console.error('DELETE /api/lc-workflow/pots/:id', e);
    res.status(500).json({ error: e.message || 'Erreur suppression pot LC' });
  }
});

app.get('/api/lc-workflow/lots/:id/pots', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const lotId = Number(req.params.id);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'id lot invalide' });
    }

    const result = await pool.query(`
      WITH lot AS (
        SELECT id, code, GREATEST(0, LEAST(18, CURRENT_DATE - COALESCE(j0_date, created_at::date)))::int AS jour_actuel
        FROM lc_lots
        WHERE id = $1
      ), today_journal AS (
        SELECT DISTINCT ON (j.lc_pot_id)
          j.lc_pot_id,
          j.id AS journal_today_id,
          j.day_index AS journal_today_day,
          j.treated_at AS today_treated_at
        FROM lc_pot_journal j
        JOIN lot l ON l.id = j.lc_lot_id
        WHERE j.day_index = l.jour_actuel
        ORDER BY j.lc_pot_id, j.treated_at DESC, j.id DESC
      ), last_journal AS (
        SELECT DISTINCT ON (j.lc_pot_id)
          j.lc_pot_id,
          j.day_index AS last_journal_day,
          j.treated_at AS last_treated_at
        FROM lc_pot_journal j
        JOIN lot l ON l.id = j.lc_lot_id
        ORDER BY j.lc_pot_id, j.day_index DESC, j.treated_at DESC, j.id DESC
      )
      SELECT
        p.*,
        (l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0')) AS code,
        l.jour_actuel,
        (tj.journal_today_id IS NOT NULL) AS today_treated,
        (tj.journal_today_id IS NOT NULL) AS treated_today,
        (tj.journal_today_id IS NOT NULL) AS done_today,
        tj.journal_today_id,
        tj.journal_today_day,
        tj.today_treated_at,
        lj.last_journal_day,
        lj.last_treated_at
      FROM lc_pots p
      JOIN lot l ON l.id = p.lc_lot_id
      LEFT JOIN today_journal tj ON tj.lc_pot_id = p.id
      LEFT JOIN last_journal lj ON lj.lc_pot_id = p.id
      WHERE p.deleted_at IS NULL
      ORDER BY p.pot_number ASC, p.id ASC
    `, [lotId]);

    if (!result.rows.length) {
      const exists = await pool.query('SELECT id FROM lc_lots WHERE id=$1', [lotId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'Lot LC introuvable' });
    }

    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/lc-workflow/lots/:id/pots', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lc-workflow/lots/:id/journal', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    let lotId = Number(req.params.id);
    const r = await pool.query(`
      SELECT j.*, p.pot_number, (l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0')) AS pot_code,
             ref.file_url AS group_reference_url
      FROM lc_pot_journal j
      JOIN lc_pots p ON p.id=j.lc_pot_id
      JOIN lc_lots l ON l.id=j.lc_lot_id
      LEFT JOIN lc_reference_day_images ref ON ref.lc_lot_id=j.lc_lot_id AND ref.day_index=j.day_index
      WHERE j.lc_lot_id=$1
      ORDER BY j.day_index DESC, p.pot_number ASC
    `, [lotId]);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/lc-workflow/lots/:id/journal', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/lc-workflow/lots/:id/journal', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureLcPotWorkflowSchema();
    let lotId = Number(req.params.id);
    const b = req.body || {};
    const potId = Number(b.lc_pot_id || b.pot_id);
    const dayIndex = Number(b.day_index);
    if (!lotId || !potId || !Number.isFinite(dayIndex)) return res.status(400).json({ error: 'lot, pot et day_index obligatoires' });
    await client.query('BEGIN');
    let pcheck = await client.query('SELECT id,pot_number,code FROM lc_pots WHERE id=$1 AND lc_lot_id=$2 AND deleted_at IS NULL', [potId, lotId]);
    if (!pcheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pot LC introuvable pour ce lot' });
    }
    const existingJournal = await client.query('SELECT id FROM lc_pot_journal WHERE lc_pot_id=$1 AND day_index=$2 LIMIT 1', [potId,dayIndex]);
    const photo = String(b.photo_url || '').trim();
    let refUrl = String(b.reference_image_url || '').trim();
    if (!refUrl) {
      let ref = await client.query('SELECT file_url FROM lc_reference_day_images WHERE lc_lot_id=$1 AND day_index=$2', [lotId, dayIndex]);
      refUrl = ref.rows[0]?.file_url || '';
    }

    let labConclusion = String(b.lab_conclusion || 'SAIN').trim().toUpperCase();
    let labContamination = String(b.lab_contamination || 'AUCUNE').trim().toUpperCase();

    let up = await client.query(`
      INSERT INTO lc_pot_journal
        (lc_lot_id, lc_pot_id, day_index, manipulation_type, magnetic_mix_minutes, temperature_c,
         photo_url, reference_image_url, note20, observations, lab_color, lab_density, lab_homogeneity,
         lab_odor, lab_contamination, lab_conclusion, check_mix_done, check_temp_ok, check_photo_done,
         check_reference_compared, operator_name, treated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now())
      ON CONFLICT (lc_pot_id, day_index)
      DO UPDATE SET manipulation_type=EXCLUDED.manipulation_type,
                    magnetic_mix_minutes=EXCLUDED.magnetic_mix_minutes,
                    temperature_c=EXCLUDED.temperature_c,
                    photo_url=EXCLUDED.photo_url,
                    reference_image_url=EXCLUDED.reference_image_url,
                    note20=EXCLUDED.note20,
                    observations=EXCLUDED.observations,
                    lab_color=EXCLUDED.lab_color,
                    lab_density=EXCLUDED.lab_density,
                    lab_homogeneity=EXCLUDED.lab_homogeneity,
                    lab_odor=EXCLUDED.lab_odor,
                    lab_contamination=EXCLUDED.lab_contamination,
                    lab_conclusion=EXCLUDED.lab_conclusion,
                    check_mix_done=EXCLUDED.check_mix_done,
                    check_temp_ok=EXCLUDED.check_temp_ok,
                    check_photo_done=EXCLUDED.check_photo_done,
                    check_reference_compared=EXCLUDED.check_reference_compared,
                    operator_name=EXCLUDED.operator_name,
                    treated_at=now()
      RETURNING *
    `, [
      lotId,
      potId,
      dayIndex,
      String(b.manipulation_type || 'VERIFICATION'),
      Number(b.magnetic_mix_minutes || 0),
      b.temperature_c === '' || b.temperature_c == null ? null : Number(b.temperature_c),
      photo,
      refUrl,
      Number(b.note20 || 10),
      String(b.observations || ''),
      String(b.lab_color || 'NORMAL'),
      String(b.lab_density || 'MOYENNE'),
      String(b.lab_homogeneity || 'HOMOGENE'),
      String(b.lab_odor || 'NON_TESTEE'),
      labContamination,
      labConclusion,
      Boolean(b.check_mix_done),
      Boolean(b.check_temp_ok),
      Boolean(b.check_photo_done),
      Boolean(b.check_reference_compared),
      String(b.operator_name || 'Admin')
    ]);

    if (photo && (b.set_as_reference === true || b.set_as_reference === 'true')) {
      await client.query(`
        INSERT INTO lc_reference_day_images(lc_lot_id, day_index, lc_pot_id, journal_id, file_url, note20, commentaire, updated_at)
        VALUES ($1,$2,$3,$4,$5,10,$6,now())
        ON CONFLICT (lc_lot_id, day_index)
        DO UPDATE SET lc_pot_id=EXCLUDED.lc_pot_id, journal_id=EXCLUDED.journal_id, file_url=EXCLUDED.file_url, note20=10, commentaire=EXCLUDED.commentaire, updated_at=now()
      `, [lotId, dayIndex, potId, up.rows[0].id, photo, `Référence LC J${dayIndex}`]);
    }

    if (labConclusion === 'CONTAMINE' || labContamination !== 'AUCUNE') {
      await client.query(`UPDATE lc_pots SET status='CONTAMINE' WHERE id=$1`, [potId]);
    } else if (labConclusion === 'SAIN' && labContamination === 'AUCUNE') {
      await client.query(`UPDATE lc_pots SET status='ACTIF' WHERE id=$1 AND status='CONTAMINE'`, [potId]);
    }

    await client.query('COMMIT');
    await recordProductionActivity(req, {
      module: 'lc', actionType: existingJournal.rows.length ? 'modified' : 'added', itemId: potId,
      itemLabel: pcheck.rows[0].code || `LC pot ${pcheck.rows[0].pot_number || potId}`, dayIndex,
      details: { lot_id: lotId, journal_id: up.rows[0].id, has_photo: Boolean(photo) }
    });
    res.status(201).json(up.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/lc-workflow/lots/:id/journal', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/lc-workflow/lots/:lotId/journal/:journalId/photo
// Removes the pot photo and any shared J-day reference that points to the same file.
app.delete('/api/lc-workflow/lots/:lotId/journal/:journalId/photo', async (req, res) => {
  const client = await pool.connect();
  let fileUrl = '';
  try {
    await ensureLcPotWorkflowSchema();
    const lotId = Number(req.params.lotId);
    const journalId = Number(req.params.journalId);
    if (!lotId || !journalId) return res.status(400).json({ error: 'lot ou journal invalide' });

    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id,lc_pot_id,day_index,photo_url FROM lc_pot_journal WHERE id=$1 AND lc_lot_id=$2 FOR UPDATE`,
      [journalId, lotId]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo du journal LC introuvable.' });
    }
    fileUrl = String(found.rows[0].photo_url || '').trim();
    if (!fileUrl) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Aucune photo à supprimer pour cette entrée.' });
    }
    if (!hasPermission(req, 'photo.delete.direct')) {
      await client.query('ROLLBACK');
      if (await queuePhotoDeletion(req,res,'lc',journalId,fileUrl,{ lotId,journalId,potId:found.rows[0].lc_pot_id,dayIndex:found.rows[0].day_index })) return;
    }

    await client.query(`DELETE FROM lc_reference_day_images WHERE journal_id=$1 OR file_url=$2`, [journalId, fileUrl]);
    await client.query(
      `UPDATE lc_pot_journal
       SET reference_image_url='' WHERE reference_image_url=$1`,
      [fileUrl]
    );
    await client.query(
      `UPDATE lc_pot_journal
       SET photo_url='', reference_image_url=CASE WHEN reference_image_url=$2 THEN '' ELSE reference_image_url END,
           check_photo_done=FALSE
       WHERE id=$1`,
      [journalId, fileUrl]
    );
    await client.query('COMMIT');

    const refs = await pool.query(
      `SELECT
         (SELECT count(*) FROM lc_pot_journal WHERE photo_url=$1 OR reference_image_url=$1) +
         (SELECT count(*) FROM lc_reference_day_images WHERE file_url=$1) AS total`,
      [fileUrl]
    );
    let storageWarning = '';
    let storageDeleted = false;
    if (!req.demoMode && Number(refs.rows[0]?.total || 0) === 0) {
      try { await deleteStoredFile(fileUrl, SITE_DIR); storageDeleted = true; }
      catch (storageError) { storageWarning = storageError.message || String(storageError); }
    }
    await recordProductionActivity(req, {
      module:'lc',actionType:'photo_deleted',itemId:found.rows[0].lc_pot_id,
      itemLabel:`LC pot ID ${found.rows[0].lc_pot_id}`,dayIndex:found.rows[0].day_index,
      details:{ lot_id:lotId,journal_id:journalId,storage_deleted:storageDeleted }
    });
    res.json({ success: true, storage_warning: storageWarning || undefined });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE LC journal photo', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});



// Validation persistante d'un pot LC : test gélose + LC validée
app.post('/api/lc-workflow/pots/:id/validation', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();

    let potId = Number(req.params.id);
    let lotId = Number(req.body?.lc_lot_id || req.body?.lot_id || 0);
    if (!potId || !lotId) {
      return res.status(400).json({ error: 'pot_id et lc_lot_id obligatoires' });
    }

    let agarValidated = req.body?.agar_test_validated === true || req.body?.agar_test_validated === 'true';
    let lcValidated = req.body?.lc_validated === true || req.body?.lc_validated === 'true';
    const notes = String(req.body?.validation_notes || '').trim();

    const up = await pool.query(`
      UPDATE lc_pots
      SET agar_test_validated=$3,
          agar_test_validated_at=CASE
            WHEN $3 = TRUE AND (agar_test_validated IS DISTINCT FROM TRUE OR agar_test_validated_at IS NULL) THEN now()
            WHEN $3 = FALSE THEN NULL
            ELSE agar_test_validated_at
          END,
          lc_validated=$4,
          lc_validated_at=CASE
            WHEN $4 = TRUE AND (lc_validated IS DISTINCT FROM TRUE OR lc_validated_at IS NULL) THEN now()
            WHEN $4 = FALSE THEN NULL
            ELSE lc_validated_at
          END,
          validation_notes=$5,
          updated_at=now()
      WHERE id=$1 AND lc_lot_id=$2 AND deleted_at IS NULL
      RETURNING *
    `, [potId, lotId, agarValidated, lcValidated, notes]);

    if (!up.rows.length) {
      return res.status(404).json({ error: 'Pot LC introuvable.' });
    }

    res.json({ ok: true, pot: up.rows[0] });
  } catch (e) {
    console.error('POST /api/lc-workflow/pots/:id/validation', e);
    res.status(500).json({ error: e.message || 'Erreur validation pot LC' });
  }
});


// Stockage frigo LC : conserve le pot validé et prépare l'étiquette avec date limite
app.post('/api/lc-workflow/pots/:id/fridge-storage', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();

    let potId = Number(req.params.id);
    const lotId = Number(req.body?.lc_lot_id || req.body?.lot_id || 0);
    const storageDays = 45;

    if (!potId || !lotId) {
      return res.status(400).json({ error: 'pot_id et lc_lot_id obligatoires' });
    }

    const days = 45;

    const check = await pool.query(`
      SELECT p.*, l.code AS lot_code, l.j0_date AS lot_j0_date
      FROM lc_pots p
      JOIN lc_lots l ON l.id=p.lc_lot_id
      WHERE p.id=$1 AND p.lc_lot_id=$2 AND p.deleted_at IS NULL
      LIMIT 1
    `, [potId, lotId]);

    if (!check.rows.length) {
      return res.status(404).json({ error: 'Pot LC introuvable.' });
    }

    let pot = check.rows[0];

    if (pot.lc_validated !== true && pot.lc_validated !== 'true') {
      return res.status(400).json({ error: 'LC non validée : validez la LC avant stockage frigo.' });
    }

    const up = await pool.query(`
      UPDATE lc_pots
      SET fridge_stored=TRUE,
          lc_created_date=COALESCE(lc_created_date, (SELECT j0_date::date FROM lc_lots WHERE id=$2), CURRENT_DATE),
          fridge_stored_at=now(),
          fridge_storage_days=$3,
          fridge_expiry_date=(CURRENT_DATE + ($3::int || ' days')::interval)::date,
          fridge_label_printed_at=now(),
          -- Ne pas modifier lc_pots.status ici : la contrainte chk_lc_pot_status
          -- n'accepte pas forcément FRIGO/STOCK. Le stockage frigo est suivi par
          -- fridge_stored, fridge_stored_at et fridge_expiry_date.
          updated_at=now()
      WHERE id=$1 AND lc_lot_id=$2 AND deleted_at IS NULL
      RETURNING *
    `, [potId, lotId, days]);

    let saved = up.rows[0];
    res.json({
      ok: true,
      pot: saved,
      label: {
        project: 'BiotechAgro',
        type: 'LC FRIGO',
        pot_code: saved.code || (pot.lot_code + '-POT-' + String(pot.pot_number).padStart(2,'0')),
        lot_code: pot.lot_code,
        lc_created_date: saved.lc_created_date || pot.lc_created_date || pot.lot_j0_date,
        stored_at: saved.fridge_stored_at,
        expiry_date: saved.fridge_expiry_date,
        conservation_days: days,
        volume_ml: saved.volume_ml || pot.volume_ml || 720
      }
    });
  } catch (e) {
    console.error('POST /api/lc-workflow/pots/:id/fridge-storage', e);
    res.status(500).json({ error: e.message || 'Erreur stockage frigo LC' });
  }
});

// Passage d'un pot LC au stock à J18, après manipulation journalière saine.
app.post('/api/lc-workflow/pots/:id/stock', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();

    let potId = Number(req.params.id);
    const lotId = Number(req.body?.lc_lot_id);
    let dayIndex = Number(req.body?.day_index);

    if (!potId || !lotId) {
      return res.status(400).json({ error: 'pot_id et lc_lot_id obligatoires' });
    }
    if (dayIndex !== 18) {
      return res.status(400).json({ error: 'Passage au stock autorisé uniquement à J18.' });
    }

    const last = await pool.query(`
      SELECT lab_contamination, lab_conclusion, note20
      FROM lc_pot_journal
      WHERE lc_pot_id=$1 AND lc_lot_id=$2 AND day_index=$3
      LIMIT 1
    `, [potId, lotId, dayIndex]);

    if (!last.rows.length) {
      return res.status(400).json({ error: 'Manipulation J18 non enregistrée.' });
    }

    let row = last.rows[0];
    let contamination = String(row.lab_contamination || 'AUCUNE').toUpperCase();
    let conclusion = String(row.lab_conclusion || 'SAIN').toUpperCase();

    if (contamination !== 'AUCUNE' || conclusion === 'CONTAMINE') {
      return res.status(400).json({ error: 'Pot contaminé ou suspect : passage au stock refusé.' });
    }

    const up = await pool.query(`
      UPDATE lc_pots
      SET stock_at=now(),
          stock_day_index=$3,
          fridge_stored=TRUE,
          fridge_stored_at=COALESCE(fridge_stored_at, now()),
          fridge_storage_days=COALESCE(fridge_storage_days, 45),
          fridge_expiry_date=COALESCE(fridge_expiry_date, (CURRENT_DATE + (COALESCE(fridge_storage_days,45)::int || ' days')::interval)::date),
          updated_at=now()
      WHERE id=$1 AND lc_lot_id=$2
      RETURNING *
    `, [potId, lotId, dayIndex]);

    if (!up.rows.length) {
      return res.status(404).json({ error: 'Pot LC introuvable.' });
    }

    return res.json({
      success: true,
      message: 'Pot LC transféré au stock',
      pot: up.rows[0]
    });
  } catch (e) {
    console.error('POST /api/lc-workflow/pots/:id/stock', e);
    return res.status(500).json({ error: e.message });
  }
});


app.post('/api/lc-workflow/lots/:id/upload-photo', lcUpload.single('photo'), async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    let lotId = Number(req.params.id);
    const potId = Number(req.body?.lc_pot_id || req.body?.pot_id);
    let dayIndex = Number(req.body?.day_index);
    if (!lotId || !potId || !Number.isFinite(dayIndex)) return res.status(400).json({ error: 'lot_id, pot_id et day_index obligatoires' });
    let chk = await pool.query('SELECT id FROM lc_pots WHERE id=$1 AND lc_lot_id=$2 AND deleted_at IS NULL AND deleted_at IS NULL LIMIT 1', [potId, lotId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Pot LC introuvable' });
    if (!req.file) return res.status(400).json({ error: 'Photo manquante' });
    const fileUrl = await persistUploadedFile({
      file: req.file,
      folder: 'lc',
      filename: req.file.filename || generatedUploadName(req, req.file, 'LCIMG'),
    });
    return res.json({ success: true, file_url: fileUrl, lc_lot_id: lotId, lc_pot_id: potId, day_index: dayIndex });
  } catch (e) {
    console.error('POST /api/lc-workflow/lots/:id/upload-photo', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/lc-workflow/lots/:id/references', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const r = await pool.query('SELECT * FROM lc_reference_day_images WHERE lc_lot_id=$1 ORDER BY day_index ASC', [Number(req.params.id)]);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/lc-workflow/lots/:id/references', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// MYCELIUM SUR GRAIN - workflow pot/sac individuel
// - LC validee -> preparation pots/sacs de grain sterile
// - semencement unitaire
// - journal quotidien + photo reference
// - protocoles de comparaison derives des donnees
// ============================================================
let grainWorkflowSchemaReady = false;
async function ensureGrainWorkflowSchema() {
  if (grainWorkflowSchemaReady) return;

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS myc_grain_batches (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      lc_lot_id BIGINT,
      lc_pot_id BIGINT,
      lc_code TEXT,
      lc_pot_code TEXT,
      parent_iso_id BIGINT,
      parent_iso_code TEXT,
      champignon TEXT,
      type_grain TEXT DEFAULT 'ble',
      container_type TEXT DEFAULT 'SAC',
      capacity_final_kg NUMERIC DEFAULT 0,
      wheat_kg NUMERIC DEFAULT 0,
      water_l NUMERIC DEFAULT 0,
      additional_components JSONB DEFAULT '[]'::jsonb,
      ratio_note TEXT,
      nb_units INTEGER DEFAULT 1,
      date_preparation DATE DEFAULT CURRENT_DATE,
      sterilization_status TEXT DEFAULT 'PREPARE',
      statut TEXT DEFAULT 'PREPARE',
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS myc_grain_units (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT NOT NULL REFERENCES myc_grain_batches(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      unit_number INTEGER NOT NULL,
      container_type TEXT DEFAULT 'SAC',
      capacity_final_kg NUMERIC DEFAULT 0,
      wheat_kg NUMERIC DEFAULT 0,
      water_l NUMERIC DEFAULT 0,
      additional_components JSONB DEFAULT '[]'::jsonb,
      statut TEXT DEFAULT 'PREPARE',
      lc_lot_id BIGINT,
      lc_pot_id BIGINT,
      lc_code TEXT,
      lc_pot_code TEXT,
      inoculated_at TIMESTAMP WITH TIME ZONE,
      inoculation_volume_ml NUMERIC DEFAULT 0,
      storage_at TIMESTAMP WITH TIME ZONE,
      storage_location TEXT,
      storage_note TEXT,
      storage_operator TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      UNIQUE(batch_id, unit_number)
    )
  `);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS myc_grain_inoculations (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      lc_lot_id BIGINT NOT NULL,
      lc_pot_id BIGINT,
      lc_code TEXT,
      lc_pot_code TEXT,
      batch_id BIGINT,
      unit_ids JSONB DEFAULT '[]'::jsonb,
      nb_units INTEGER DEFAULT 0,
      inoculation_volume_ml NUMERIC DEFAULT 0,
      date_inoculation DATE DEFAULT CURRENT_DATE,
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS myc_grain_journal (
      id BIGSERIAL PRIMARY KEY,
      grain_unit_id BIGINT NOT NULL REFERENCES myc_grain_units(id) ON DELETE CASCADE,
      batch_id BIGINT NOT NULL REFERENCES myc_grain_batches(id) ON DELETE CASCADE,
      day_index INTEGER NOT NULL DEFAULT 0,
      manipulation_type TEXT DEFAULT 'CONTROLE_VISUEL',
      temperature_c NUMERIC,
      photo_url TEXT,
      reference_image_url TEXT,
      score20 NUMERIC DEFAULT 10,
      propagation_pct NUMERIC DEFAULT 0,
      observations TEXT,
      check_visual_control BOOLEAN DEFAULT FALSE,
      check_no_contamination BOOLEAN DEFAULT FALSE,
      check_mycelium_visible BOOLEAN DEFAULT FALSE,
      check_growth_progress BOOLEAN DEFAULT FALSE,
      check_temp_ok BOOLEAN DEFAULT FALSE,
      check_reference_compared BOOLEAN DEFAULT FALSE,
      contamination_level TEXT DEFAULT 'AUCUNE',
      conclusion TEXT DEFAULT 'SAIN',
      operator_name TEXT,
      treated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      UNIQUE(grain_unit_id, day_index)
    )
  `);

  await realPool.query(`
    CREATE TABLE IF NOT EXISTS myc_grain_reference_images (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT NOT NULL REFERENCES myc_grain_batches(id) ON DELETE CASCADE,
      day_index INTEGER NOT NULL DEFAULT 0,
      grain_unit_id BIGINT,
      journal_id BIGINT,
      file_url TEXT NOT NULL,
      score20 NUMERIC DEFAULT 10,
      commentaire TEXT,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      UNIQUE(batch_id, day_index)
    )
  `);

  await realPool.query(`ALTER TABLE myc_grain_batches ADD COLUMN IF NOT EXISTS additional_components JSONB DEFAULT '[]'::jsonb`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS additional_components JSONB DEFAULT '[]'::jsonb`);
  await realPool.query(`ALTER TABLE myc_grain_batches ADD COLUMN IF NOT EXISTS source_petri_id BIGINT`);
  await realPool.query(`ALTER TABLE myc_grain_batches ADD COLUMN IF NOT EXISTS p3_code TEXT`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS source_petri_id BIGINT`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS p3_code TEXT`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS storage_at TIMESTAMP WITH TIME ZONE`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS storage_location TEXT`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS storage_note TEXT`);
  await realPool.query(`ALTER TABLE myc_grain_units ADD COLUMN IF NOT EXISTS storage_operator TEXT`);
  await realPool.query(`ALTER TABLE myc_grain_inoculations ADD COLUMN IF NOT EXISTS source_petri_id BIGINT`);
  await realPool.query(`ALTER TABLE myc_grain_inoculations ADD COLUMN IF NOT EXISTS p3_code TEXT`);

  await realPool.query(`CREATE INDEX IF NOT EXISTS idx_myc_grain_units_batch ON myc_grain_units(batch_id)`);
  await realPool.query(`CREATE INDEX IF NOT EXISTS idx_myc_grain_units_statut ON myc_grain_units(statut)`);
  await realPool.query(`CREATE INDEX IF NOT EXISTS idx_myc_grain_batches_lc ON myc_grain_batches(lc_lot_id, lc_pot_id)`);
  await realPool.query(`CREATE INDEX IF NOT EXISTS idx_myc_grain_journal_unit_day ON myc_grain_journal(grain_unit_id, day_index)`);

  grainWorkflowSchemaReady = true;
}

function grainBatchCode() { return genCode('GRN'); }
function grainInocCode() { return genCode('SEM'); }
function grainUnitCode(batchCode, containerType, n) {
  const t = String(containerType || 'SAC').toUpperCase().startsWith('POT') ? 'POT' : 'SAC';
  return `${batchCode}-${t}-${String(n).padStart(3, '0')}`;
}

async function getValidatedLcSelection(lcLotId, lcPotId) {
  await ensureLcPotWorkflowSchema();
  const params = [Number(lcLotId || 0)];
  let potFilter = '';
  if (lcPotId) {
    params.push(Number(lcPotId));
    potFilter = `AND p.id=$${params.length}`;
  }
  const q = await pool.query(`
    SELECT l.id AS lc_lot_id,
           l.code AS lc_code,
           l.parent_iso_id,
           l.parent_iso_code,
           COALESCE(l.champignon, i.champignon, '') AS champignon,
           p.id AS lc_pot_id,
           COALESCE(p.code, l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0')) AS lc_pot_code,
           p.lc_validated,
           p.agar_test_validated,
           p.lc_validated_at,
           l.source_petri_id,
           CASE
             WHEN sp.id IS NOT NULL THEN COALESCE(i.code, l.parent_iso_code, 'ISO') || '-P3-' || sp.id::text
             WHEN l.source_petri_id IS NOT NULL THEN 'P3-' || l.source_petri_id::text
             ELSE NULL
           END AS p3_code,
           p.fridge_stored,
           p.fridge_expiry_date
    FROM lc_lots l
    JOIN lc_pots p ON p.lc_lot_id=l.id
    LEFT JOIN isolements i ON i.id=l.parent_iso_id
    LEFT JOIN iso_petris sp ON sp.id=l.source_petri_id
    WHERE l.id=$1
      ${potFilter}
      AND p.deleted_at IS NULL
      AND COALESCE(p.lc_validated, FALSE)=TRUE
    ORDER BY p.lc_validated_at DESC NULLS LAST, p.pot_number ASC
    LIMIT 1
  `, params);
  return q.rows[0] || null;
}

// LC validees utilisables pour le grain : uniquement les pots LC marques "LC validee".
app.get('/api/grain-lc-valides', async (req, res) => {
  try {
    await ensureLcPotWorkflowSchema();
    const r = await pool.query(`
      SELECT l.id AS lc_lot_id,
             l.code AS lc_code,
             l.parent_iso_id,
             l.parent_iso_code,
             COALESCE(l.champignon, i.champignon, '') AS champignon,
             p.id AS lc_pot_id,
             COALESCE(p.code, l.code || '-POT-' || LPAD(p.pot_number::text, 2, '0')) AS lc_pot_code,
             p.pot_number,
             p.volume_ml,
             p.agar_test_validated,
             p.lc_validated,
             p.lc_validated_at,
             l.source_petri_id,
             CASE
               WHEN sp.id IS NOT NULL THEN COALESCE(i.code, l.parent_iso_code, 'ISO') || '-P3-' || sp.id::text
               WHEN l.source_petri_id IS NOT NULL THEN 'P3-' || l.source_petri_id::text
               ELSE NULL
             END AS p3_code,
             p.fridge_stored,
             p.fridge_expiry_date,
             l.j0_date,
             l.created_at
      FROM lc_lots l
      JOIN lc_pots p ON p.lc_lot_id=l.id
      LEFT JOIN isolements i ON i.id=l.parent_iso_id
      LEFT JOIN iso_petris sp ON sp.id=l.source_petri_id
      WHERE p.deleted_at IS NULL
        AND COALESCE(p.lc_validated, FALSE)=TRUE
      ORDER BY p.lc_validated_at DESC NULLS LAST, l.id DESC, p.pot_number ASC
      LIMIT 500
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/grain-lc-valides', e);
    res.status(500).json({ error: e.message });
  }
});

// Preparations pot/sac de grain.
app.get('/api/grain-batches', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const r = await pool.query(`
      SELECT b.*,
             (SELECT COUNT(*)::int FROM myc_grain_units u WHERE u.batch_id=b.id) AS units_total,
             (SELECT COUNT(*)::int FROM myc_grain_units u WHERE u.batch_id=b.id AND u.statut='PREPARE') AS units_prepared,
             (SELECT COUNT(*)::int FROM myc_grain_units u WHERE u.batch_id=b.id AND u.statut IN ('ENSEMENCE','EN_INCUBATION')) AS units_inoculated,
             (SELECT COUNT(*)::int FROM myc_grain_units u WHERE u.batch_id=b.id AND u.statut='CONTAMINE') AS units_contaminated,
             (SELECT ROUND(AVG(j.propagation_pct), 1)
                FROM myc_grain_journal j
                JOIN myc_grain_units u ON u.id=j.grain_unit_id
               WHERE u.batch_id=b.id
                 AND j.treated_at = (SELECT MAX(j2.treated_at) FROM myc_grain_journal j2 WHERE j2.grain_unit_id=j.grain_unit_id)
             ) AS avg_last_propagation
      FROM myc_grain_batches b
      ORDER BY b.created_at DESC
      LIMIT 500
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/grain-batches', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/grain-batches', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureGrainWorkflowSchema();
    const b = req.body || {};

    // Creation grain = preparation sterile liee a une isolation.
    // A ce stade il n'y a pas encore de LC injectee, donc on NE demande PAS lc_lot_id/lc_pot_id.
    const parentIsoId = Number(b.parent_iso_id || b.isolation_id || 0);
    if (!parentIsoId) {
      return res.status(400).json({ error: 'Selection isolation invalide : choisissez une isolation.' });
    }

    const isoRes = await client.query(
      `SELECT id, code, champignon, cycle_type FROM isolements WHERE id=$1 LIMIT 1`,
      [parentIsoId]
    );
    if (!isoRes.rows.length) {
      return res.status(404).json({ error: 'Isolation introuvable.' });
    }
    const iso = isoRes.rows[0];

    const typeGrain = String(b.type_grain || 'ble').trim().toLowerCase();
    if (typeGrain !== 'ble') return res.status(400).json({ error: 'Pour le moment, seul le ble est autorise.' });

    const containerType = String(b.container_type || 'SAC').trim().toUpperCase().startsWith('POT') ? 'POT' : 'SAC';
    const capacityFinalKg = Number(b.capacity_final_kg || 0);
    const wheatKg = Number(b.wheat_kg || 0);
    const waterL = Number(b.water_l || 0);
    const additionalComponents = (Array.isArray(b.additional_components) ? b.additional_components : [])
      .map((item) => ({
        name: String(item && (item.name || item.nom) || '').trim(),
        quantity: Number(item && (item.quantity ?? item.quantite) || 0),
        unit: String(item && (item.unit || item.unite) || 'g').trim()
      }))
      .filter((item) => item.name && Number.isFinite(item.quantity) && item.quantity > 0)
      .slice(0, 20);
    const allowedUnits = new Set(['kg', 'g', 'L', 'mL']);
    if (additionalComponents.some((item) => !allowedUnits.has(item.unit))) {
      return res.status(400).json({ error: 'Unite de composition invalide. Unites acceptees : kg, g, L, mL.' });
    }
    const nbUnits = Math.max(1, Math.min(500, Number(b.nb_units || 1)));
    const datePreparation = String(b.date_preparation || new Date().toISOString().slice(0, 10)).slice(0, 10);

    if (!capacityFinalKg || !wheatKg || waterL < 0 || !nbUnits) {
      return res.status(400).json({ error: 'capacite finale, ble kg, eau L et nombre unites sont obligatoires.' });
    }

    const code = grainBatchCode();
    await client.query('BEGIN');

    const ins = await client.query(`
      INSERT INTO myc_grain_batches
        (code, lc_lot_id, lc_pot_id, lc_code, lc_pot_code, parent_iso_id, parent_iso_code, champignon,
         source_petri_id, p3_code, type_grain, container_type, capacity_final_kg, wheat_kg, water_l, additional_components, ratio_note, nb_units,
         date_preparation, sterilization_status, statut, notes)
      VALUES ($1,NULL,NULL,NULL,NULL,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'PREPARE','PREPARE',$14)
      RETURNING *
    `, [
      code,
      iso.id,
      iso.code,
      iso.champignon,
      typeGrain,
      containerType,
      capacityFinalKg,
      wheatKg,
      waterL,
      JSON.stringify(additionalComponents),
      `${wheatKg} kg ble / ${waterL} L eau${additionalComponents.length ? ' + ' + additionalComponents.map((x) => `${x.quantity} ${x.unit} ${x.name}`).join(' + ') : ''}`,
      nbUnits,
      datePreparation,
      String(b.notes || '')
    ]);

    const batch = ins.rows[0];
    for (let i = 1; i <= nbUnits; i++) {
      await client.query(`
        INSERT INTO myc_grain_units
          (batch_id, code, unit_number, container_type, capacity_final_kg, wheat_kg, water_l, additional_components, statut, source_petri_id, p3_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'PREPARE',NULL,NULL)
      `, [batch.id, grainUnitCode(batch.code, containerType, i), i, containerType, capacityFinalKg, wheatKg, waterL, JSON.stringify(additionalComponents)]);
    }

    await client.query('COMMIT');
    const full = await pool.query(`SELECT * FROM myc_grain_units WHERE batch_id=$1 ORDER BY unit_number ASC`, [batch.id]);
    res.status(201).json({ ...batch, units: full.rows });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/grain-batches', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/grain-units', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const batchId = Number(req.query.batch_id || 0);
    const status = String(req.query.status || '').trim().toUpperCase();
    let params = [];
    let where = [];
    if (batchId) { params.push(batchId); where.push(`u.batch_id=$${params.length}`); }
    if (status) { params.push(status); where.push(`u.statut=$${params.length}`); }

    const r = await pool.query(`
      SELECT u.*,
             b.code AS batch_code,
             b.parent_iso_id,
             b.parent_iso_code,
             b.champignon,
             b.type_grain,
             b.date_preparation,
             b.lc_code AS batch_lc_code,
             b.lc_pot_code AS batch_lc_pot_code,
             COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id) AS source_petri_id,
             COALESCE(u.p3_code, b.p3_code,
               CASE
                 WHEN sp.id IS NOT NULL THEN COALESCE(b.parent_iso_code, ll.parent_iso_code, 'ISO') || '-P3-' || sp.id::text
                 WHEN COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id) IS NOT NULL THEN 'P3-' || COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id)::text
                 ELSE NULL
               END
             ) AS p3_code,
             last_j.day_index AS last_day_index,
             last_j.propagation_pct AS last_propagation_pct,
             last_j.score20 AS last_score20,
             last_j.conclusion AS last_conclusion,
             last_j.treated_at AS last_treated_at
      FROM myc_grain_units u
      JOIN myc_grain_batches b ON b.id=u.batch_id
      LEFT JOIN lc_lots ll ON ll.id = COALESCE(u.lc_lot_id, b.lc_lot_id)
      LEFT JOIN iso_petris sp ON sp.id = COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id)
      LEFT JOIN LATERAL (
        SELECT j.* FROM myc_grain_journal j
        WHERE j.grain_unit_id=u.id
        ORDER BY j.day_index DESC, j.treated_at DESC
        LIMIT 1
      ) last_j ON TRUE
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 1000
    `, params);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/grain-units', e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// GRAIN UNIT SUMMARY / STOCK
// Used by admin-myc-grain.html and admin-myc-grain-journal.html.
// ============================================================

// GET /api/grain-units/:id/summary
// Returns one pot/sac with its preparation/LC source information and journal summary.
app.get('/api/grain-units/:id/summary', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();

    const unitId = Number(req.params.id || 0);
    if (!unitId) {
      return res.status(400).json({ error: 'id pot/sac invalide' });
    }

    const unitResult = await pool.query(`
      SELECT
        u.*,
        b.code AS batch_code,
        b.parent_iso_id,
        b.parent_iso_code,
        b.champignon,
        b.type_grain,
        b.date_preparation,
        b.notes AS batch_notes,
        b.lc_code AS batch_lc_code,
        b.lc_pot_code AS batch_lc_pot_code,
        COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id) AS resolved_source_petri_id,
        COALESCE(
          u.p3_code,
          b.p3_code,
          CASE
            WHEN sp.id IS NOT NULL
              THEN COALESCE(b.parent_iso_code, ll.parent_iso_code, 'ISO') || '-P3-' || sp.id::text
            WHEN COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id) IS NOT NULL
              THEN 'P3-' || COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id)::text
            ELSE NULL
          END
        ) AS resolved_p3_code
      FROM myc_grain_units u
      JOIN myc_grain_batches b ON b.id = u.batch_id
      LEFT JOIN lc_lots ll ON ll.id = COALESCE(u.lc_lot_id, b.lc_lot_id)
      LEFT JOIN iso_petris sp
        ON sp.id = COALESCE(u.source_petri_id, b.source_petri_id, ll.source_petri_id)
      WHERE u.id = $1
      LIMIT 1
    `, [unitId]);

    if (!unitResult.rows.length) {
      return res.status(404).json({ error: 'Pot/sac grain introuvable.' });
    }

    const unit = unitResult.rows[0];

    // Keep the field names already expected by both frontends.
    if (!unit.source_petri_id && unit.resolved_source_petri_id) {
      unit.source_petri_id = unit.resolved_source_petri_id;
    }
    if (!unit.p3_code && unit.resolved_p3_code) {
      unit.p3_code = unit.resolved_p3_code;
    }
    delete unit.resolved_source_petri_id;
    delete unit.resolved_p3_code;

    const journalResult = await pool.query(`
      SELECT
        j.*,
        ref.file_url AS batch_reference_url
      FROM myc_grain_journal j
      LEFT JOIN myc_grain_reference_images ref
        ON ref.batch_id = j.batch_id
       AND ref.day_index = j.day_index
      WHERE j.grain_unit_id = $1
      ORDER BY j.day_index DESC, j.treated_at DESC, j.id DESC
    `, [unitId]);

    const journal = journalResult.rows || [];
    const lastEntry = journal.length ? journal[0] : null;

    return res.json({
      success: true,
      unit,
      summary: {
        journal_count: journal.length,
        last_entry: lastEntry,
        first_entry: journal.length ? journal[journal.length - 1] : null,
        history: journal
      }
    });
  } catch (e) {
    console.error('GET /api/grain-units/:id/summary', e);
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/grain-units/:id/stock
// Marks a pot/sac as stored and persists its storage information.
app.post('/api/grain-units/:id/stock', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();

    const unitId = Number(req.params.id || 0);
    if (!unitId) {
      return res.status(400).json({ error: 'id pot/sac invalide' });
    }

    const body = req.body || {};
    const storageLocation = String(body.storage_location || '').trim();
    const storageNote = String(body.storage_note || '').trim();
    const storageOperator = String(
      body.storage_operator ||
      (req.adminSession && req.adminSession.username) ||
      'Admin'
    ).trim();

    const updated = await pool.query(`
      UPDATE myc_grain_units
      SET statut = 'STOCK',
          storage_at = COALESCE(storage_at, now()),
          storage_location = $2,
          storage_note = $3,
          storage_operator = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [unitId, storageLocation, storageNote, storageOperator]);

    if (!updated.rows.length) {
      return res.status(404).json({ error: 'Pot/sac grain introuvable.' });
    }

    return res.json({
      success: true,
      message: 'Pot/sac grain mis au stock.',
      unit: updated.rows[0]
    });
  } catch (e) {
    console.error('POST /api/grain-units/:id/stock', e);
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/api/grain-units/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureGrainWorkflowSchema();
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: 'id pot/sac invalide' });

    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id, code, batch_id FROM myc_grain_units WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pot/sac introuvable' });
    }
    const unit = cur.rows[0];
    const batchId = Number(unit.batch_id);

    await client.query(`DELETE FROM myc_grain_units WHERE id=$1`, [id]);

    const counts = await client.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE statut='PREPARE')::int AS prepared,
             COUNT(*) FILTER (WHERE statut <> 'PREPARE')::int AS inoculated
      FROM myc_grain_units
      WHERE batch_id=$1
    `, [batchId]);
    const c = counts.rows[0] || { total: 0, prepared: 0, inoculated: 0 };
    let statut = 'PREPARE';
    if (Number(c.total) === 0) statut = 'SUPPRIME';
    else if (Number(c.prepared) === 0) statut = 'ENSEMENCE';
    else if (Number(c.inoculated) > 0) statut = 'PARTIELLEMENT_ENSEMENCE';

    await client.query(
      `UPDATE myc_grain_batches SET nb_units=$2, statut=$3, updated_at=now() WHERE id=$1`,
      [batchId, Number(c.total), statut]
    );

    await client.query('COMMIT');
    res.json({ ok: true, deleted_id: id, deleted_code: unit.code, batch_id: batchId, batch_status: statut });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE /api/grain-units/:id', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// Alias compatibilite avec l'ancienne page.
app.get('/api/grain-lots', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const r = await pool.query(`
      SELECT id, code, type_grain, container_type, capacity_final_kg, wheat_kg, water_l,
             source_petri_id, p3_code,
             nb_units AS nb_sacs_total,
             (SELECT COUNT(*)::int FROM myc_grain_units u WHERE u.batch_id=b.id AND u.statut <> 'PREPARE') AS nb_sacs_used,
             date_preparation AS date_sterilisation,
             created_at
      FROM myc_grain_batches b
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grain-lots', async (req, res) => {
  res.status(400).json({
    error: 'Route ancienne desactivee : utilisez POST /api/grain-batches avec une LC validee.'
  });
});

app.post('/api/grain-inoculations', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureGrainWorkflowSchema();
    const b = req.body || {};
    const lcLotId = Number(b.lc_lot_id || 0);
    const lcPotId = Number(b.lc_pot_id || 0);
    const selectedLc = await getValidatedLcSelection(lcLotId, lcPotId || null);
    if (!selectedLc) return res.status(400).json({ error: 'Selection LC invalide : choisissez une LC validee.' });

    let unitIds = Array.isArray(b.unit_ids) ? b.unit_ids.map(Number).filter(Boolean) : [];
    const batchId = Number(b.batch_id || 0);
    const nbUnits = Number(b.nb_units || unitIds.length || 0);
    const vol = Number(b.inoculation_volume_ml || b.vol_lc_par_sac_ml || 0);
    const dateInoc = String(b.date_inoculation || new Date().toISOString().slice(0,10)).slice(0,10);
    const dateInocDateTimeRaw = String(b.date_inoculation_datetime || '').trim();
    const dateInocDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(dateInocDateTimeRaw)
      ? dateInocDateTimeRaw
      : `${dateInoc}T${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}:00`;
    if (!vol || vol <= 0) return res.status(400).json({ error: 'Volume LC par pot/sac obligatoire.' });

    await client.query('BEGIN');

    if (!unitIds.length && batchId && nbUnits) {
      const q = await client.query(`
        SELECT id FROM myc_grain_units
        WHERE batch_id=$1 AND statut='PREPARE'
        ORDER BY unit_number ASC
        LIMIT $2
        FOR UPDATE
      `, [batchId, nbUnits]);
      unitIds = q.rows.map(x => Number(x.id));
    }

    if (!unitIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Aucun pot/sac prepare selectionne.' });
    }

    const units = await client.query(`
      SELECT u.*, b.id AS b_id
      FROM myc_grain_units u
      JOIN myc_grain_batches b ON b.id=u.batch_id
      WHERE u.id = ANY($1)
      FOR UPDATE
    `, [unitIds]);

    if (units.rows.length !== unitIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Certains pots/sacs sont introuvables.' });
    }
    const unavailable = units.rows.filter(u => String(u.statut).toUpperCase() !== 'PREPARE');
    if (unavailable.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Certains pots/sacs sont deja ensemences ou non disponibles.' });
    }

    const mainBatchId = Number(units.rows[0].batch_id);
    const code = grainInocCode();
    await client.query(`
      INSERT INTO myc_grain_inoculations
        (code, lc_lot_id, lc_pot_id, lc_code, lc_pot_code, source_petri_id, p3_code, batch_id, unit_ids, nb_units, inoculation_volume_ml, date_inoculation, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      code,
      selectedLc.lc_lot_id,
      selectedLc.lc_pot_id,
      selectedLc.lc_code,
      selectedLc.lc_pot_code,
      selectedLc.source_petri_id || null,
      selectedLc.p3_code || null,
      mainBatchId,
      JSON.stringify(unitIds),
      unitIds.length,
      vol,
      dateInoc,
      String(b.notes || '')
    ]);

    await client.query(`
      UPDATE myc_grain_units
      SET statut='ENSEMENCE',
          lc_lot_id=$2,
          lc_pot_id=$3,
          lc_code=$4,
          lc_pot_code=$5,
          source_petri_id=$6,
          p3_code=$7,
          inoculated_at=($8::timestamp AT TIME ZONE 'Africa/Tunis'),
          inoculation_volume_ml=$9,
          updated_at=now()
      WHERE id=ANY($1)
    `, [unitIds, selectedLc.lc_lot_id, selectedLc.lc_pot_id, selectedLc.lc_code, selectedLc.lc_pot_code, selectedLc.source_petri_id || null, selectedLc.p3_code || null, dateInocDateTime, vol]);

    await client.query(`
      UPDATE myc_grain_batches
      SET statut='PARTIELLEMENT_ENSEMENCE', updated_at=now()
      WHERE id=$1
    `, [mainBatchId]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, code, nb_units: unitIds.length, unit_ids: unitIds, lc_code: selectedLc.lc_code, lc_pot_code: selectedLc.lc_pot_code, source_petri_id: selectedLc.source_petri_id || null, p3_code: selectedLc.p3_code || null });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/grain-inoculations', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/spawn-lots', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const r = await pool.query(`
      SELECT i.id, i.code, i.lc_lot_id, i.lc_code AS lc_lot_code,
             i.batch_id AS grain_lot_id, b.code AS grain_lot_code,
             i.nb_units AS nb_sacs, i.inoculation_volume_ml AS vol_lc_par_sac_ml,
             'EN_INCUBATION' AS statut, i.created_at
      FROM myc_grain_inoculations i
      LEFT JOIN myc_grain_batches b ON b.id=i.batch_id
      ORDER BY i.created_at DESC
      LIMIT 500
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spawn-lots', async (req, res) => {
  res.status(400).json({
    error: 'Route ancienne desactivee : utilisez POST /api/grain-inoculations avec les pots/sacs prepares.'
  });
});

app.post('/api/grain-workflow/upload-photo', grainUpload.single('photo'), async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    if (!req.file) return res.status(400).json({ error: 'Photo manquante' });
    const fileUrl = await persistUploadedFile({
      file: req.file,
      folder: 'grain',
      filename: req.file.filename || generatedUploadName(req, req.file, 'GRAINIMG'),
    });
    res.json({ success: true, file_url: fileUrl });
  } catch (e) {
    console.error('POST /api/grain-workflow/upload-photo', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/grain-units/:id/journal', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const unitId = Number(req.params.id);
    const r = await pool.query(`
      SELECT j.*, u.code AS unit_code, b.code AS batch_code,
             ref.file_url AS batch_reference_url
      FROM myc_grain_journal j
      JOIN myc_grain_units u ON u.id=j.grain_unit_id
      JOIN myc_grain_batches b ON b.id=j.batch_id
      LEFT JOIN myc_grain_reference_images ref ON ref.batch_id=j.batch_id AND ref.day_index=j.day_index
      WHERE j.grain_unit_id=$1
      ORDER BY j.day_index ASC
    `, [unitId]);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/grain-units/:id/journal', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/grain-units/:id/journal', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureGrainWorkflowSchema();
    const unitId = Number(req.params.id);
    const b = req.body || {};
    const dayIndex = Number(b.day_index || 0);
    await client.query('BEGIN');

    const unitQ = await client.query(`SELECT * FROM myc_grain_units WHERE id=$1 LIMIT 1`, [unitId]);
    if (!unitQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pot/sac grain introuvable.' });
    }
    const unit = unitQ.rows[0];
    const existingJournal = await client.query(`SELECT id FROM myc_grain_journal WHERE grain_unit_id=$1 AND day_index=$2 LIMIT 1`, [unitId,dayIndex]);
    let refUrl = String(b.reference_image_url || '').trim();
    if (!refUrl) {
      const rr = await client.query(`SELECT file_url FROM myc_grain_reference_images WHERE batch_id=$1 AND day_index=$2`, [unit.batch_id, dayIndex]);
      refUrl = rr.rows[0]?.file_url || '';
    }

    const conclusion = String(b.conclusion || 'SAIN').trim().toUpperCase();
    const contamination = String(b.contamination_level || 'AUCUNE').trim().toUpperCase();
    const saved = await client.query(`
      INSERT INTO myc_grain_journal
        (grain_unit_id, batch_id, day_index, manipulation_type, temperature_c, photo_url, reference_image_url,
         score20, propagation_pct, observations, check_visual_control, check_no_contamination, check_mycelium_visible,
         check_growth_progress, check_temp_ok, check_reference_compared, contamination_level, conclusion, operator_name, treated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
      ON CONFLICT (grain_unit_id, day_index)
      DO UPDATE SET manipulation_type=EXCLUDED.manipulation_type,
                    temperature_c=EXCLUDED.temperature_c,
                    photo_url=EXCLUDED.photo_url,
                    reference_image_url=EXCLUDED.reference_image_url,
                    score20=EXCLUDED.score20,
                    propagation_pct=EXCLUDED.propagation_pct,
                    observations=EXCLUDED.observations,
                    check_visual_control=EXCLUDED.check_visual_control,
                    check_no_contamination=EXCLUDED.check_no_contamination,
                    check_mycelium_visible=EXCLUDED.check_mycelium_visible,
                    check_growth_progress=EXCLUDED.check_growth_progress,
                    check_temp_ok=EXCLUDED.check_temp_ok,
                    check_reference_compared=EXCLUDED.check_reference_compared,
                    contamination_level=EXCLUDED.contamination_level,
                    conclusion=EXCLUDED.conclusion,
                    operator_name=EXCLUDED.operator_name,
                    treated_at=now()
      RETURNING *
    `, [
      unitId,
      unit.batch_id,
      dayIndex,
      String(b.manipulation_type || 'CONTROLE_VISUEL'),
      b.temperature_c === '' || b.temperature_c == null ? null : Number(b.temperature_c),
      String(b.photo_url || '').trim(),
      refUrl,
      Number(b.score20 || 10),
      Number(b.propagation_pct || 0),
      String(b.observations || ''),
      Boolean(b.check_visual_control),
      Boolean(b.check_no_contamination),
      Boolean(b.check_mycelium_visible),
      Boolean(b.check_growth_progress),
      Boolean(b.check_temp_ok),
      Boolean(b.check_reference_compared),
      contamination,
      conclusion,
      String(b.operator_name || 'Admin')
    ]);

    if (String(b.photo_url || '').trim() && (b.set_as_reference === true || b.set_as_reference === 'true')) {
      await client.query(`
        INSERT INTO myc_grain_reference_images(batch_id, day_index, grain_unit_id, journal_id, file_url, score20, commentaire, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (batch_id, day_index)
        DO UPDATE SET grain_unit_id=EXCLUDED.grain_unit_id,
                      journal_id=EXCLUDED.journal_id,
                      file_url=EXCLUDED.file_url,
                      score20=EXCLUDED.score20,
                      commentaire=EXCLUDED.commentaire,
                      updated_at=now()
      `, [unit.batch_id, dayIndex, unitId, saved.rows[0].id, String(b.photo_url).trim(), Number(b.score20 || 10), `Reference grain J${dayIndex}`]);
    }

    if (conclusion === 'CONTAMINE' || contamination !== 'AUCUNE') {
      await client.query(`UPDATE myc_grain_units SET statut='CONTAMINE', updated_at=now() WHERE id=$1`, [unitId]);
    } else if (Number(b.propagation_pct || 0) >= 95) {
      await client.query(`UPDATE myc_grain_units SET statut='PRET', updated_at=now() WHERE id=$1`, [unitId]);
    } else if (String(unit.statut).toUpperCase() === 'ENSEMENCE') {
      await client.query(`UPDATE myc_grain_units SET statut='EN_INCUBATION', updated_at=now() WHERE id=$1`, [unitId]);
    }

    await client.query('COMMIT');
    await recordProductionActivity(req, {
      module: 'grain', actionType: existingJournal.rows.length ? 'modified' : 'added', itemId: unitId,
      itemLabel: unit.code || `Grain unité ID ${unitId}`, dayIndex,
      details: { batch_id: unit.batch_id, journal_id: saved.rows[0].id, has_photo: Boolean(String(b.photo_url || '').trim()) }
    });
    res.status(201).json(saved.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/grain-units/:id/journal', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/grain-units/:unitId/journal/:journalId/photo
app.delete('/api/grain-units/:unitId/journal/:journalId/photo', async (req, res) => {
  const client = await pool.connect();
  let fileUrl = '';
  try {
    await ensureGrainWorkflowSchema();
    const unitId = Number(req.params.unitId);
    const journalId = Number(req.params.journalId);
    if (!unitId || !journalId) return res.status(400).json({ error: 'pot/sac ou journal invalide' });

    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id,grain_unit_id,day_index,photo_url FROM myc_grain_journal WHERE id=$1 AND grain_unit_id=$2 FOR UPDATE`,
      [journalId, unitId]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo du journal grain introuvable.' });
    }
    fileUrl = String(found.rows[0].photo_url || '').trim();
    if (!fileUrl) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Aucune photo à supprimer pour cette entrée.' });
    }
    if (!hasPermission(req, 'photo.delete.direct')) {
      await client.query('ROLLBACK');
      if (await queuePhotoDeletion(req,res,'grain',journalId,fileUrl,{ unitId,journalId,dayIndex:found.rows[0].day_index })) return;
    }

    await client.query(`DELETE FROM myc_grain_reference_images WHERE journal_id=$1 OR file_url=$2`, [journalId, fileUrl]);
    await client.query(`UPDATE myc_grain_journal SET reference_image_url='' WHERE reference_image_url=$1`, [fileUrl]);
    await client.query(
      `UPDATE myc_grain_journal
       SET photo_url='', reference_image_url=CASE WHEN reference_image_url=$2 THEN '' ELSE reference_image_url END
       WHERE id=$1`,
      [journalId, fileUrl]
    );
    await client.query('COMMIT');

    const refs = await pool.query(
      `SELECT
         (SELECT count(*) FROM myc_grain_journal WHERE photo_url=$1 OR reference_image_url=$1) +
         (SELECT count(*) FROM myc_grain_reference_images WHERE file_url=$1) AS total`,
      [fileUrl]
    );
    let storageWarning = '';
    let storageDeleted = false;
    if (!req.demoMode && Number(refs.rows[0]?.total || 0) === 0) {
      try { await deleteStoredFile(fileUrl, SITE_DIR); storageDeleted = true; }
      catch (storageError) { storageWarning = storageError.message || String(storageError); }
    }
    await recordProductionActivity(req, {
      module:'grain',actionType:'photo_deleted',itemId:unitId,
      itemLabel:`Grain unité ID ${unitId}`,dayIndex:found.rows[0].day_index,
      details:{ journal_id:journalId,storage_deleted:storageDeleted }
    });
    res.json({ success: true, storage_warning: storageWarning || undefined });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE grain journal photo', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/grain-protocols', async (req, res) => {
  try {
    await ensureGrainWorkflowSchema();
    const growth = await pool.query(`
      SELECT COALESCE(parent_iso_code, 'ISO-INCONNUE') AS isolation,
             COUNT(DISTINCT b.id)::int AS batches_count,
             COUNT(DISTINCT u.id)::int AS units_count,
             COUNT(DISTINCT u.lc_pot_id)::int AS lc_count,
             ROUND(AVG(last_j.propagation_pct), 1) AS avg_propagation,
             ROUND(AVG(last_j.score20), 1) AS avg_score
      FROM myc_grain_batches b
      JOIN myc_grain_units u ON u.batch_id=b.id
      LEFT JOIN LATERAL (
        SELECT j.* FROM myc_grain_journal j WHERE j.grain_unit_id=u.id ORDER BY j.day_index DESC, j.treated_at DESC LIMIT 1
      ) last_j ON TRUE
      GROUP BY COALESCE(parent_iso_code, 'ISO-INCONNUE')
      ORDER BY isolation ASC
    `);

    const lcComp = await pool.query(`
      SELECT COALESCE(b.parent_iso_code, 'ISO-INCONNUE') AS isolation,
             COUNT(DISTINCT u.lc_pot_id)::int AS lc_count,
             COUNT(DISTINCT u.id)::int AS units_count,
             ROUND(AVG(last_j.propagation_pct), 1) AS avg_propagation,
             ROUND(AVG(last_j.score20), 1) AS avg_score
      FROM myc_grain_batches b
      JOIN myc_grain_units u ON u.batch_id=b.id
      LEFT JOIN LATERAL (
        SELECT j.* FROM myc_grain_journal j WHERE j.grain_unit_id=u.id ORDER BY j.day_index DESC, j.treated_at DESC LIMIT 1
      ) last_j ON TRUE
      WHERE u.lc_pot_id IS NOT NULL
      GROUP BY COALESCE(b.parent_iso_code, 'ISO-INCONNUE')
      HAVING COUNT(DISTINCT u.lc_pot_id) > 1
      ORDER BY isolation ASC
    `);

    res.json({
      growth_speed: growth.rows,
      lc_same_isolation: lcComp.rows,
      needs_growth_protocol: growth.rows.length > 1,
      needs_lc_protocol: lcComp.rows.length > 0
    });
  } catch (e) {
    console.error('GET /api/grain-protocols', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GELOSES
// ============================================================

// GET /api/isolements/:id/geloses
app.get("/api/isolements/:id/geloses", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id isolement invalide" });

    const r = await pool.query(
      `SELECT id, isolement_id, nom, quantite_ml, recette, created_at, updated_at
       FROM iso_geloses
       WHERE isolement_id=$1
       ORDER BY id ASC`,
      [isolementId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/isolements/:id/geloses
app.post("/api/isolements/:id/geloses", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    const { nom, recette, quantite_ml } = req.body || {};
    if (!isolementId) return res.status(400).json({ error: "id isolement invalide" });

    // Validation quantité (1-50000 ml, défaut 500ml)
    let qtyMl = Number(quantite_ml || 500);
    if (qtyMl < 1 || qtyMl > 50000) {
      return res.status(400).json({ error: "Quantité invalide (1-50000 ml)" });
    }

    const r = await pool.query(
      `INSERT INTO iso_geloses (isolement_id, nom, quantite_ml, recette)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [isolementId, String(nom || "Gélose"), qtyMl, recette || {}]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/geloses/:id
app.patch("/api/geloses/:id", async (req, res) => {
  try {
    let geloseId = Number(req.params.id);
    const { nom, recette, quantite_ml } = req.body || {};
    if (!geloseId) return res.status(400).json({ error: "id gélose invalide" });

    // Validation quantité si fournie
    if (quantite_ml !== undefined) {
      const qtyMl = Number(quantite_ml);
      if (qtyMl < 1 || qtyMl > 50000) {
        return res.status(400).json({ error: "Quantité invalide (1-50000 ml)" });
      }
    }

    const r = await pool.query(
      `UPDATE iso_geloses
       SET nom = COALESCE($2, nom),
           recette = COALESCE($3, recette),
           quantite_ml = COALESCE($4, quantite_ml),
           updated_at = now()
       WHERE id=$1
       RETURNING *`,
      [
        geloseId, 
        nom === undefined ? null : String(nom), 
        recette === undefined ? null : recette,
        quantite_ml === undefined ? null : Number(quantite_ml)
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Gélose introuvable" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PETRIS (P1/P2/P3)
// ============================================================

// GET /api/isolements/:id/petris
app.get("/api/isolements/:id/petris", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id isolement invalide" });

    await ensureIsoPetrisStorageSchema();
    const r = await pool.query(
      `SELECT p.id, p.isolement_id, p.parent_id, p.phase, p.j0, p.status, p.created_at, p.storage_at, p.storage_limit_at, p.gelose_id,
              EXISTS (SELECT 1 FROM iso_petri_journal j WHERE j.petri_id = p.id) AS is_treated,
              EXISTS (SELECT 1 FROM iso_petri_journal j WHERE j.petri_id = p.id AND j.journal_date = CURRENT_DATE) AS is_today_treated,
              (SELECT COUNT(*)::int FROM iso_petri_journal j WHERE j.petri_id = p.id) AS treated_days_count,
              (SELECT MAX(j.treated_at) FROM iso_petri_journal j WHERE j.petri_id = p.id) AS last_treated_at
       FROM iso_petris p
       WHERE p.isolement_id=$1 AND p.deleted_at IS NULL
       ORDER BY p.created_at ASC, p.id ASC`,
      [isolementId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/isolements/:id/petris
// - CrÃ©ation P1 : { phase:1, j0:YYYY-MM-DD, gelose_id }
// - Piquage P2/P3 : { phase:2|3, j0:YYYY-MM-DD, parent_id }
app.post("/api/isolements/:id/petris", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    const { phase, j0, gelose_id, parent_id, qty } = req.body || {};
    let ph = Number(phase);
    const q = Math.max(1, Number(qty || 1));
    if (!isolementId) return res.status(400).json({ error: "id isolement invalide" });
    if (![1, 2, 3].includes(ph)) return res.status(400).json({ error: "phase invalide (1/2/3)" });
    if (!j0) return res.status(400).json({ error: "j0 obligatoire (YYYY-MM-DD)" });

    // P2/P3 : parent obligatoire, gelose_id laissÃ© Ã  la DB (trigger) si dÃ©jÃ  dÃ©fini
    if (ph !== 1 && !parent_id) {
      return res.status(400).json({ error: "parent_id obligatoire pour P2/P3" });
    }

    // P1 : gelose_id obligatoire
    if (ph === 1 && !gelose_id) {
      return res.status(400).json({ error: "gelose_id obligatoire pour P1" });
    }

    const created = [];
    for (let i = 0; i < q; i++) {
      const r = await pool.query(
        `INSERT INTO iso_petris (isolement_id, parent_id, phase, j0, gelose_id)
         VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT gelose_id FROM iso_petris WHERE id=$2)))
         RETURNING *`,
        [
          isolementId,
          parent_id ? Number(parent_id) : null,
          ph,
          String(j0).slice(0, 10),
          gelose_id ? Number(gelose_id) : null,
        ]
      );
      created.push(r.rows[0]);
    }
    res.status(201).json(q > 1 ? created : created[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/petris/:id
app.get("/api/petris/:id", async (req, res) => {
  try {
    let petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });
    const r = await pool.query(
      `SELECT id, isolement_id, parent_id, phase, j0, status, storage_at, deleted_at, deleted_reason, label_printed_at, label_print_count, created_at, gelose_id
       FROM iso_petris
       WHERE id=$1 AND deleted_at IS NULL`,
      [petriId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "BoÃ®te introuvable" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/petris/:id/piquer
// Cree une nouvelle boite (P2 ou P3). Autorisee seulement si le dernier jour traite est marque mycelium piquable.
app.post("/api/petris/:id/piquer", async (req, res) => {
  try {
    let parentId = Number(req.params.id);
    if (!parentId) return res.status(400).json({ success: false, error: "id petri invalide" });

    let parentRes = await pool.query(
      `SELECT p.id, p.isolement_id, p.phase, p.gelose_id, p.status, p.deleted_at,
              i.code AS iso_code, i.champignon, i.cycle_type,
              g.nom AS gelose_nom
       FROM iso_petris p
       JOIN isolements i ON i.id = p.isolement_id
       LEFT JOIN iso_geloses g ON g.id = p.gelose_id
       WHERE p.id=$1
       LIMIT 1`,
      [parentId]
    );
    if (!parentRes.rows.length) return res.status(404).json({ success: false, error: "Boite introuvable" });

    let parent = parentRes.rows[0];
    if (parent.deleted_at) return res.status(400).json({ success: false, error: "Boite supprimee/archivee" });

    let parentPhase = Number(parent.phase);
    if (![1, 2].includes(parentPhase)) {
      return res.status(400).json({ success: false, error: "Piquage autorise uniquement pour P1 ou P2" });
    }

    const lastObsRes = await pool.query(
      `SELECT id, day_index, is_pickable, choices, visual_note20, obs
       FROM iso_petri_journal
       WHERE petri_id=$1
       ORDER BY day_index DESC, journal_date DESC, id DESC
       LIMIT 1`,
      [parentId]
    );
    let lastObs = lastObsRes.rows[0];
    let pickableByChoice = !!(lastObs && lastObs.choices && (lastObs.choices.is_pickable || lastObs.choices.mycelium_pickable));
    let isPickable = !!(lastObs && (lastObs.is_pickable || pickableByChoice));

    if (!isPickable) {
      return res.status(400).json({
        success: false,
        error: "Piquage refuse : traite le jour courant et coche mycelium piquable."
      });
    }

    let info = await getPetriIsoMeta(parentId);
    if (info.error) return res.status(info.code).json({ success: false, error: info.error });
    if (isExpired90(info.jour_actuel, info.meta)) {
      return res.status(400).json({
        success: false,
        error: `Perime: stockage frigo depasse (J${info.jour_actuel} > J${info.meta.cycleDuration + 90})`
      });
    }

    let newPhase = parentPhase + 1;
    const j0 = ymd(new Date());
    const operateur = String(req.body?.operateur || "Admin").trim();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ins = await client.query(
        `INSERT INTO iso_petris (isolement_id, parent_id, phase, j0, gelose_id, status, label_printed_at, label_print_count)
         VALUES ($1, $2, $3, $4, $5, 'EN_COURS', now(), 1)
         RETURNING id, isolement_id, parent_id, phase, j0, status, gelose_id, label_printed_at, label_print_count, created_at`,
        [Number(parent.isolement_id), parentId, newPhase, j0, Number(parent.gelose_id)]
      );

      await client.query(
        `UPDATE iso_petris SET status='PIQUE' WHERE id=$1 AND status='EN_COURS'`,
        [parentId]
      );

      await client.query("COMMIT");

      const created = ins.rows[0];
      let boxId = `ISO-${created.isolement_id}-P${created.id}`;
      let label = {
        boxId,
        isolement_id: created.isolement_id,
        petri_id: created.id,
        phase: created.phase,
        parent_id: parentId,
        gelose_id: created.gelose_id,
        gelose_nom: parent.gelose_nom || `Gelose ${created.gelose_id}`,
        champignon: parent.champignon || "",
        cycle_type: parent.cycle_type || "",
        j0: created.j0,
        operateur,
        action: `Piquage P${parentPhase} -> P${newPhase}`,
        print_now: true
      };

      return res.status(201).json({ success: true, created, boxId, label });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/petris/:id/piquer", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// VALIDATION P1 / P2 / P3 (fenêtre optimale atteinte)
// Règle: une phase peut être validée dès que jour_actuel >= fenetre_optimale_debut
// (pas de "trop tard" bloquant : fin de cycle -> frigo 4°C)
// ============================================================

async function getPetriIsoMeta(petriId) {
  let petriRes = await pool.query(
    `SELECT id, isolement_id, parent_id, phase, j0, status
     FROM iso_petris
     WHERE id=$1
     LIMIT 1`,
    [petriId]
  );
  if (!petriRes.rows.length) return { error: "Boîte introuvable", code: 404 };

  let petri = petriRes.rows[0];

  const isoRes = await pool.query(
    `SELECT id, cycle_type, date_prelev
     FROM isolements
     WHERE id=$1
     LIMIT 1`,
    [Number(petri.isolement_id)]
  );
  if (!isoRes.rows.length) return { error: "Isolement introuvable", code: 404 };

  const iso = isoRes.rows[0];

  const j0 = parseYMD(petri.j0);
  if (!j0) return { error: "j0 (date de début) manquante ou invalide", code: 400 };

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let jour_actuel = Math.max(0, diffDays(j0, today));

  let meta = getCycleMetaFromIso(iso); // { cycleDuration, optimalStart, optimalEnd }

  return { petri, iso, jour_actuel, meta };
}

function isAlreadyValidated(status) {
  let st = String(status || "").toUpperCase();
  return (st === "VALIDE" || st === "VALIDÉ" || st === "VALIDÉ_P1" || st === "VALIDÉ_P2" || st === "VALIDÉ_P3");
}

function isExpired90(jour_actuel, meta) {
  let limit = Number(meta?.cycleDuration ?? 0) + 90;
  return Number(jour_actuel) > limit;
}

// POST /api/petris/:id/valider-p1
app.post("/api/petris/:id/valider-p1", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const info = await getPetriIsoMeta(petriId);
    if (info.error) return res.status(info.code).json({ error: info.error });

    const { petri, jour_actuel, meta } = info;

    if (Number(petri.phase) !== 1) return res.status(400).json({ error: "Validation réservée à P1" });
    if (isAlreadyValidated(petri.status)) return res.status(409).json({ error: "P1 déjà validée" });

    if (jour_actuel < meta.optimalStart) {
      return res.status(400).json({
        error: `Trop tôt: fenêtre optimale pas encore atteinte (J${jour_actuel} < J${meta.optimalStart})`
      });
    }

    if (isExpired90(jour_actuel, meta)) {
      return res.status(400).json({ error: `Périmé: stockage frigo dépassé (J${jour_actuel} > J${meta.cycleDuration + 90})` });
    }

    const up = await pool.query(
      `UPDATE iso_petris
       SET status=$2
       WHERE id=$1
       RETURNING id, isolement_id, phase, j0, status, created_at`,
      [petriId, "VALIDE"]
    );

    return res.json({ success: true, updated: up.rows[0] });
  } catch (e) {
    console.error("POST /api/petris/:id/valider-p1", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/petris/:id/valider-p2
app.post("/api/petris/:id/valider-p2", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const info = await getPetriIsoMeta(petriId);
    if (info.error) return res.status(info.code).json({ error: info.error });

    const { petri, jour_actuel, meta } = info;

    if (Number(petri.phase) !== 2) return res.status(400).json({ error: "Validation réservée à P2" });
    if (isAlreadyValidated(petri.status)) return res.status(409).json({ error: "P2 déjà validée" });

    if (jour_actuel < meta.optimalStart) {
      return res.status(400).json({
        error: `Trop tôt: fenêtre optimale pas encore atteinte (J${jour_actuel} < J${meta.optimalStart})`
      });
    }

    if (isExpired90(jour_actuel, meta)) {
      return res.status(400).json({ error: `Périmé: stockage frigo dépassé (J${jour_actuel} > J${meta.cycleDuration + 90})` });
    }

    const up = await pool.query(
      `UPDATE iso_petris
       SET status=$2
       WHERE id=$1
       RETURNING id, isolement_id, phase, j0, status, created_at`,
      [petriId, "VALIDE"]
    );

    return res.json({ success: true, updated: up.rows[0] });
  } catch (e) {
    console.error("POST /api/petris/:id/valider-p2", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/petris/:id/valider-p3
app.post("/api/petris/:id/valider-p3", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const info = await getPetriIsoMeta(petriId);
    if (info.error) return res.status(info.code).json({ error: info.error });

    const { petri, jour_actuel, meta } = info;

    if (Number(petri.phase) !== 3) return res.status(400).json({ error: "Validation réservée à P3" });
    if (isAlreadyValidated(petri.status)) {
      return res.status(409).json({ error: "P3 déjà validée (une seule validation autorisée)" });
    }

    if (jour_actuel < meta.optimalStart) {
      return res.status(400).json({
        error: `Trop tôt: fenêtre optimale pas encore atteinte (J${jour_actuel} < J${meta.optimalStart})`
      });
    }

    if (isExpired90(jour_actuel, meta)) {
      return res.status(400).json({ error: `Périmé: stockage frigo dépassé (J${jour_actuel} > J${meta.cycleDuration + 90})` });
    }

    const up = await pool.query(
      `UPDATE iso_petris
       SET status=$2
       WHERE id=$1
       RETURNING id, isolement_id, phase, j0, status, created_at`,
      [petriId, "VALIDE"]
    );

    return res.json({ success: true, updated: up.rows[0] });
  } catch (e) {
    console.error("POST /api/petris/:id/valider-p3", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});





// POST /api/petris/:id/perimer-p3
// Marque une boîte P3 comme PERIME (décision manuelle en fin de cycle)
app.post("/api/petris/:id/perimer-p3", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const r = await pool.query(
      `SELECT id, isolement_id, phase, status
       FROM iso_petris
       WHERE id=$1
       LIMIT 1`,
      [petriId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Boîte introuvable" });

    const p = r.rows[0];
    if (Number(p.phase) !== 3) {
      return res.status(400).json({ error: "Périmé réservé à P3" });
    }

    const st = String(p.status || "").toUpperCase();
    if (st === "VALIDE" || st === "VALIDÉ" || st === "VALIDÉ_P3") {
      return res.status(409).json({ error: "Impossible : P3 déjà validée" });
    }
    if (st === "PERIME" || st === "PERIMEE" || st === "PÉRIMÉ" || st === "PERIMÉE") {
      return res.status(409).json({ error: "P3 déjà marqué PERIME" });
    }
    if (st === "UTILISE" || st === "UTILISÉ") {
      return res.status(409).json({ error: "Impossible : P3 déjà utilisé" });
    }

    const up = await pool.query(
      `UPDATE iso_petris
       SET status=$2
       WHERE id=$1
       RETURNING id, isolement_id, phase, j0, status, gelose_id, created_at`,
      [petriId, "PERIME"]
    );

    const updated = up.rows[0];
    const boxId = `ISO-${updated.isolement_id}-P${updated.id}`;

    return res.json({ success: true, updated, boxId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/petris/:id/stock-frigo
// Marque une boite comme stockee au frigo.
async function handleStockFrigo(req, res) {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ success: false, error: "id petri invalide" });

    await ensureIsoPetrisStorageSchema();
    let months = Number(req.body?.months || 6);
    let rawStorageAt = String(req.body?.storage_at || '').trim();
    let hasDate = /^\d{4}-\d{2}-\d{2}$/.test(rawStorageAt);

    const up = await pool.query(
      `UPDATE iso_petris
       SET status='STOCK_FRIGO',
           storage_at = CASE
             WHEN $2::text <> '' THEN ($2::date)::timestamp
             ELSE now()
           END,
           storage_limit_at = (CASE
             WHEN $2::text <> '' THEN ($2::date)::timestamp
             ELSE now()
           END + ($3::text || ' months')::interval)
       WHERE id=$1 AND deleted_at IS NULL
       RETURNING id, isolement_id, phase, j0, status, storage_at, storage_limit_at, gelose_id, created_at`,
      [petriId, hasDate ? rawStorageAt : '', String(months || 6)]
    );
    if (!up.rows.length) return res.status(404).json({ success: false, error: "Boite introuvable" });
    const updated = up.rows[0];
    let storage_limit_at = updated.storage_limit_at || null;

    return res.json({
      success: true,
      data: {
        ...updated,
        storage_limit_at
      },
      updated: {
        ...updated,
        storage_limit_at
      },
      boxId: `ISO-${updated.isolement_id}-P${updated.id}`
    });
  } catch (e) {
    console.error("POST /api/petris/:id/stock-frigo", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
app.post("/api/petris/:id/stock-frigo", handleStockFrigo);
app.put("/api/petris/:id/stock-frigo", handleStockFrigo);
app.post("/api/petris/:id/conservation-frigorifique", handleStockFrigo);
app.put("/api/petris/:id/conservation-frigorifique", handleStockFrigo);

// DELETE /api/petris/:id
// Corbeille logique : la boite est cachee mais reste tracable.
app.delete("/api/petris/:id", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ success: false, error: "id petri invalide" });
    let reason = String(req.body?.reason || "Suppression operateur").trim();
    const up = await pool.query(
      `UPDATE iso_petris
       SET status='SUPPRIME', deleted_at=now(), deleted_reason=$2
       WHERE id=$1 AND deleted_at IS NULL
       RETURNING id, isolement_id, phase, j0, status, deleted_at, deleted_reason`,
      [petriId, reason]
    );
    if (!up.rows.length) return res.status(404).json({ success: false, error: "Boite introuvable ou deja supprimee" });
    return res.json({ success: true, deleted: up.rows[0] });
  } catch (e) {
    console.error("DELETE /api/petris/:id", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/petris/:id/journal?days=30
app.get("/api/petris/:id/journal", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    const days = Math.min(90, Math.max(1, Number(req.query.days || 30)));
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const r = await pool.query(
      `SELECT id, petri_id, journal_date, day_index, choices, stop, image_url, visual_note20, total_score, obs, created_at, updated_at
       FROM iso_petri_journal
       WHERE petri_id=$1
       ORDER BY journal_date ASC
       LIMIT $2`,
      [petriId, days]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPSERT /api/petris/:id/journal (sauvegarde jour)
app.post("/api/petris/:id/journal", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    const {
      journal_date,
      day_index,
      choices,
      stop,
      image_url,
      visual_note20,
      total_score,
      obs,
      isolement_id,
    } = req.body || {};

    if (!petriId) return res.status(400).json({ error: "id petri invalide" });
    if (!journal_date) return res.status(400).json({ error: "journal_date obligatoire" });
    if (day_index === undefined || day_index === null)
      return res.status(400).json({ error: "day_index obligatoire" });

    const r = await pool.query(
      `INSERT INTO iso_petri_journal
         (petri_id, journal_date, day_index, choices, stop, image_url, visual_note20, total_score, obs, isolement_id)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (petri_id, journal_date)
       DO UPDATE SET
         day_index=EXCLUDED.day_index,
         choices=EXCLUDED.choices,
         stop=EXCLUDED.stop,
         image_url=EXCLUDED.image_url,
         visual_note20=EXCLUDED.visual_note20,
         total_score=EXCLUDED.total_score,
         obs=EXCLUDED.obs,
         updated_at=now()
       RETURNING *`,
      [
        petriId,
        String(journal_date).slice(0, 10),
        Number(day_index),
        choices || {},
        Boolean(stop),
        String(image_url || ""),
        Number(visual_note20 || 0),
        Number(total_score || 0),
        String(obs || ""),
        isolement_id ? Number(isolement_id) : null,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/isolements/:id/petri-journals  (pour protocole + graphes)
app.get("/api/isolements/:id/petri-journals", async (req, res) => {
  try {
    const isolementId = Number(req.params.id);
    if (!isolementId) return res.status(400).json({ error: "id isolement invalide" });

    const r = await pool.query(
      `SELECT j.id, j.petri_id, j.journal_date, j.day_index, j.visual_note20, j.total_score, j.stop,
              p.phase, p.parent_id, p.gelose_id
       FROM iso_petri_journal j
       JOIN iso_petris p ON p.id = j.petri_id
       WHERE p.isolement_id=$1
       ORDER BY p.gelose_id ASC, p.phase ASC, j.day_index ASC, j.journal_date ASC`,
      [isolementId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ✅ COMPAT: API attendue par admin-isolement-journal.html
// Ajoute /api/journal/* sans casser le reste
// ============================================================

function parseBoxId(boxId) {
  // attendu: ISO-<isoId>-P<petriId>
  const m = String(boxId || "").match(/^ISO-(\d+)-P(\d+)$/i);
  if (!m) return null;
  return { isoId: Number(m[1]), petriId: Number(m[2]) };
}

function getCycleMetaFromIso(iso) {
  // Regle BiotechAgro issue des tests reels.
  // Agaricus bisporus : adaptation a un nouveau milieu sur environ 14 jours.
  // Exception LC : transfert depuis P3 valide avec micro-fragment et minimum de gelose.
  // Le piquage depend aussi du champ is_pickable valide dans le journal.
  const cycle = String(iso.cycle_type || "").trim().toUpperCase();
  if (cycle === "AGARICUS") {
    return { cycleDuration: 14, optimalStart: 14, optimalEnd: 14, storageDay: 14 };
  }
  return { cycleDuration: 21, optimalStart: 5, optimalEnd: 21, storageDay: 21 };
}

// GET /api/journal/:boxId
app.get("/api/journal/:boxId", async (req, res) => {
  try {
    const boxId = String(req.params.boxId || "").trim();
    let parsed = parseBoxId(boxId);
    if (!parsed) {
      return res.status(400).json({ success: false, error: "boxId invalide. Format attendu: ISO-<isoId>-P<petriId>" });
    }

    const { isoId, petriId } = parsed;

    // 1) Petri
    const petriRes = await pool.query(
      `SELECT id, isolement_id, phase, j0, status, gelose_id
       FROM iso_petris
       WHERE id=$1
       LIMIT 1`,
      [petriId]
    );
    if (!petriRes.rows.length) {
      return res.status(404).json({ success: false, error: "Petri introuvable" });
    }
    const petri = petriRes.rows[0];

    // 2) Isolement (on vérifie cohérence si isoId fourni)
    const isolementId = Number(petri.isolement_id);
    const isoRes = await pool.query(
      `SELECT id, code, champignon, cycle_type, date_prelev
       FROM isolements
       WHERE id=$1
       LIMIT 1`,
      [isolementId]
    );
    if (!isoRes.rows.length) {
      return res.status(404).json({ success: false, error: "Isolement introuvable" });
    }
    const iso = isoRes.rows[0];

    // si l’URL contient isoId qui ne correspond pas, on continue quand même (compat)
    // mais tu peux activer un guard strict si tu veux.
    // if (isoId !== isolementId) ...

    const j0 = parseYMD(petri.j0);
    if (!j0) {
      return res.status(400).json({ success: false, error: "j0 (date de début petri) invalide ou manquante" });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const jour_actuel = Math.max(0, diffDays(j0, today));

    const meta = getCycleMetaFromIso(iso);

    // 3) Journal rows (on prend jusqu’à la durée du cycle)
    let journalRes = await pool.query(
      `SELECT id, petri_id, journal_date, day_index, choices, image_url, visual_note20, total_score, obs,
              manipulation_type, is_pickable, reference_image_url, is_reference, treated_at, operator_name,
              (SELECT ap.id FROM iso_petri_album_photos ap
               WHERE ap.journal_observation_id=iso_petri_journal.id
               ORDER BY ap.id DESC LIMIT 1) AS album_photo_id
       FROM iso_petri_journal
       WHERE petri_id=$1
       ORDER BY day_index ASC`,
      [petriId]
    );

    const rows = journalRes.rows || [];
    let byDay = new Map();
    for (const r of rows) byDay.set(Number(r.day_index), r);

    // Références communes EXACTES : même isolement + même phase + même jour.
    // Important : pas de fallback J4 -> J5/J6. Chaque jour a sa référence.
    await ensureReferenceDaySchema();
    let refsRes = await pool.query(
      `SELECT day_index, file_url, source_petri_id, album_photo_id, note20
       FROM iso_reference_phase_images
       WHERE isolement_id=$1 AND phase=$2`,
      [isolementId, Number(petri.phase)]
    );
    let refsByDay = new Map();
    for (const ref of refsRes.rows || []) refsByDay.set(Number(ref.day_index), ref);

    // observations: tableau par jour 0..cycleDuration
    let observations = [];
    for (let day = 0; day <= meta.cycleDuration; day++) {
      const r = byDay.get(day);
      let choices = (r && r.choices && typeof r.choices === "object") ? r.choices : {};
      let exactRef = refsByDay.get(day) || null;
      let ownPhotoIsDailyRef = !!(r && r.is_reference && r.image_url);

      observations.push({
        jour_cycle: day,
        traite: !!r, // traité si ligne existe
        journal_id: r ? Number(r.id) : null,
        album_photo_id: r?.album_photo_id ? Number(r.album_photo_id) : null,
        // champs attendus par le front:
        score_questions: Number(r?.total_score || 0),
        note_evolution: Number(r?.visual_note20 || 10),
        notes_observation: String(r?.obs || ""),

        // q1..q6 attendus via q.field (q1_croissance_visible etc.)
        q1_croissance_visible: !!choices.q1_croissance_visible,
        q2_colonisation_complete: !!choices.q2_colonisation_complete,
        q3_absence_contamination: !!choices.q3_absence_contamination,
        q4_mycelium_blanc_dense: !!choices.q4_mycelium_blanc_dense,
        q5_odeur_caracteristique: !!choices.q5_odeur_caracteristique,
        q6_bonne_adherence: !!choices.q6_bonne_adherence,

        image_url: String(r?.image_url || ""),
        manipulation_type: String(r?.manipulation_type || choices.manipulation_type || ""),
        is_pickable: !!(r?.is_pickable || choices.is_pickable),
        reference_image_url: exactRef ? String(exactRef.file_url || "") : (ownPhotoIsDailyRef ? String(r.image_url || "") : ""),
        reference_source_petri_id: exactRef ? Number(exactRef.source_petri_id || 0) : null,
        reference_album_photo_id: exactRef ? Number(exactRef.album_photo_id || 0) : null,
        reference_note20: exactRef ? Number(exactRef.note20 || 10) : null,
        is_reference: ownPhotoIsDailyRef,
        operator_name: String(r?.operator_name || choices.operateur || "")
      });
    }

    // alertes: jours passés non traités
    let alertes = [];
    for (let day = 0; day < Math.min(jour_actuel, meta.cycleDuration + 1); day++) {
      const r = byDay.get(day);
      if (!r) {
        const d = new Date(j0);
        d.setDate(d.getDate() + day);
        alertes.push({ jour_cycle: day, date_observation: ymd(d) });
      }
    }

    // boite: structure attendue par ton front

    // Statut calculé selon l'évolution dans le cycle (sans "Production")
    // - Avant fenêtre optimale : EN_INCUBATION
    // - Fenêtre optimale : P1/P2 -> PRET_A_PIQUER, P3 -> PRET_A_VALIDER
    // - Après fin de cycle : PERIME
    let status_calc = "EN_INCUBATION";
    const lastObs = rows.length ? rows[rows.length - 1] : null;
    let lastChoices = (lastObs && lastObs.choices && typeof lastObs.choices === "object") ? lastObs.choices : {};
    let lastPickable = !!(lastObs && (lastObs.is_pickable || lastChoices.is_pickable));
    if (["STOCK_FRIGO", "CONSERVATION_FRIGORIFIQUE", "STOCK", "CONSERVATION"].includes(String(petri.status || "").toUpperCase())) {
      status_calc = "STOCK_FRIGO";
    } else if (Number(petri.phase) === 3 && jour_actuel >= meta.storageDay) {
      status_calc = "PRET_STOCKAGE_FRIGO";
    } else if ([1, 2].includes(Number(petri.phase)) && lastPickable) {
      status_calc = "PRET_A_PIQUER";
    } else if (jour_actuel > meta.cycleDuration + 90) {
      status_calc = "PERIME";
    } else {
      status_calc = "EN_INCUBATION";
    }

    let referenceImagesByDay = {};
    for (const ref of refsRes.rows || []) {
      referenceImagesByDay[String(Number(ref.day_index))] = {
        file_url: String(ref.file_url || ""),
        source_petri_id: ref.source_petri_id ? Number(ref.source_petri_id) : null,
        album_photo_id: ref.album_photo_id ? Number(ref.album_photo_id) : null,
        note20: ref.note20 ? Number(ref.note20) : 10
      };
    }

    const boite = {
      id_boite: boxId,
      code_boite: boxId,
      phase: Number(petri.phase),
      status: String(petri.status || ""),
      status_calc,
      espece: String(iso.cycle_type || ""),
      cycle_duree_jours: meta.cycleDuration,
      fenetre_optimale_debut: meta.optimalStart,
      fenetre_optimale_fin: meta.optimalEnd,
      jour_actuel,
      date_debut: ymd(j0),
      reference_image_url: "",
      reference_images_by_day: referenceImagesByDay,
      reference_logic: "isolement+phase+day",
      gelose_id: petri.gelose_id,
    };

    return res.json({
      success: true,
      data: { boite, observations, alertes }
    });

  } catch (e) {
    console.error("GET /api/journal/:boxId", e);
    res.status(500).json({ success: false, error: e.message });
  }
});


// POST /api/journal/observation
app.post("/api/journal/observation", async (req, res) => {
  try {
    const b = req.body || {};
    const boxId = String(b.id_boite || "").trim();
    const day = Number(b.jour_cycle);

    const parsed = parseBoxId(boxId);
    if (!parsed) return res.status(400).json({ success: false, error: "id_boite invalide" });

    const { petriId } = parsed;

    // Calcul score selon tes points (total 20)
    let score =
      (b.q1 ? 3 : 0) +
      (b.q2 ? 4 : 0) +
      (b.q3 ? 5 : 0) +
      (b.q4 ? 3 : 0) +
      (b.q5 ? 2 : 0) +
      (b.q6 ? 3 : 0);

    // récupérer j0 du petri pour calculer journal_date
    const petriRes = await pool.query(`SELECT id, isolement_id, phase, j0 FROM iso_petris WHERE id=$1 LIMIT 1`, [petriId]);
    if (!petriRes.rows.length) return res.status(404).json({ success: false, error: "Petri introuvable" });

    const j0 = parseYMD(petriRes.rows[0].j0);
    if (!j0) return res.status(400).json({ success: false, error: "j0 petri invalide" });

    const d = new Date(j0);
    d.setDate(d.getDate() + day);
    const journal_date = ymd(d);
    const existingJournal = await pool.query(`SELECT id FROM iso_petri_journal WHERE petri_id=$1 AND journal_date=$2 LIMIT 1`, [petriId,journal_date]);

    let manipulation_type = String(b.manipulation_type || b.type_manipulation || "Observation quotidienne").trim();
    let is_pickable = !!(b.is_pickable || b.mycelium_pickable);
    let operator_name = String(b.operateur || b.operator_name || "").trim();

    const choices = {
      q1_croissance_visible: !!b.q1,
      q2_colonisation_complete: !!b.q2,
      q3_absence_contamination: !!b.q3,
      q4_mycelium_blanc_dense: !!b.q4,
      q5_odeur_caracteristique: !!b.q5,
      q6_bonne_adherence: !!b.q6,
      is_pickable,
      manipulation_type,
      operateur: operator_name
    };

    const r = await pool.query(
      `INSERT INTO iso_petri_journal
         (petri_id, journal_date, day_index, choices, stop, image_url, visual_note20, total_score, obs, isolement_id,
          manipulation_type, is_pickable, treated_at, operator_name)
       VALUES
         ($1,$2,$3,$4,FALSE,'',$5,$6,$7,$8,$9,$10,now(),$11)
       ON CONFLICT (petri_id, journal_date)
       DO UPDATE SET
         day_index=EXCLUDED.day_index,
         choices=EXCLUDED.choices,
         visual_note20=EXCLUDED.visual_note20,
         total_score=EXCLUDED.total_score,
         obs=EXCLUDED.obs,
         manipulation_type=EXCLUDED.manipulation_type,
         is_pickable=EXCLUDED.is_pickable,
         treated_at=COALESCE(iso_petri_journal.treated_at, now()),
         operator_name=EXCLUDED.operator_name,
         updated_at=now()
       RETURNING *`,
      [
        petriId,
        journal_date,
        day,
        choices,
        Number(b.note_evolution || 10),
        Number(score),
        String(b.notes || ""),
        Number(petriRes.rows[0].isolement_id || null),
        manipulation_type,
        is_pickable,
        operator_name,
      ]
    );

    await recordProductionActivity(req, {
      module: 'petri', actionType: existingJournal.rows.length ? 'modified' : 'added', itemId: petriId,
      itemLabel: `P${Number(petriRes.rows[0].phase || parsed.phase || 0)} ID ${petriId}`, dayIndex: day,
      details: { isolement_id: petriRes.rows[0].isolement_id, journal_id: r.rows[0].id }
    });
    return res.json({ success: true, data: { id_observation: r.rows[0].id } });
  } catch (e) {
    console.error("POST /api/journal/observation", e);
    res.status(500).json({ success: false, error: e.message });
  }
});



// GET /api/petris/:id/album
// Album photo propre à une boîte P
app.get("/api/petris/:id/album", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ success: false, error: "id petri invalide" });

    const r = await pool.query(
      `SELECT id, petri_id, isolement_id, gelose_id, journal_observation_id,
              day_index, file_url, note20, remarque, is_reference_candidate, created_at
       FROM iso_petri_album_photos
       WHERE petri_id=$1
       ORDER BY created_at DESC, id DESC`,
      [petriId]
    );

    res.json({ success: true, rows: r.rows });
  } catch (e) {
    console.error("GET /api/petris/:id/album", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/album-photos/:id
// Used by both the isolation journal and the Petri summary album.
app.delete("/api/album-photos/:id", async (req, res) => {
  const client = await pool.connect();
  let fileUrl = '';
  try {
    await ensureReferenceDaySchema();
    const photoId = Number(req.params.id);
    if (!photoId) return res.status(400).json({ success: false, error: "id photo invalide" });

    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM iso_petri_album_photos WHERE id=$1 FOR UPDATE`, [photoId]);
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: "Photo introuvable" });
    }
    const photo = found.rows[0];
    fileUrl = String(photo.file_url || '').trim();
    if (!hasPermission(req, 'photo.delete.direct')) {
      await client.query('ROLLBACK');
      if (await queuePhotoDeletion(req,res,'petri',photoId,fileUrl,{ petriId:photo.petri_id,albumPhotoId:photoId,dayIndex:photo.day_index,itemLabel:`Petri ID ${photo.petri_id}` })) return;
    }

    await client.query(`DELETE FROM iso_reference_phase_images WHERE album_photo_id=$1 OR file_url=$2`, [photoId, fileUrl]);
    await client.query(
      `UPDATE iso_petri_journal
       SET image_url=CASE WHEN image_url=$2 THEN '' ELSE image_url END,
           reference_image_url=CASE WHEN reference_image_url=$2 THEN '' ELSE reference_image_url END,
           is_reference=CASE WHEN image_url=$2 OR reference_image_url=$2 THEN FALSE ELSE is_reference END
       WHERE id=$1 OR (petri_id=$3 AND (image_url=$2 OR reference_image_url=$2))`,
      [photo.journal_observation_id, fileUrl, photo.petri_id]
    );
    await client.query(`DELETE FROM iso_petri_album_photos WHERE id=$1`, [photoId]);
    await client.query('COMMIT');

    const refs = await pool.query(
      `SELECT
         (SELECT count(*) FROM iso_petri_journal WHERE image_url=$1 OR reference_image_url=$1) +
         (SELECT count(*) FROM iso_petri_album_photos WHERE file_url=$1) +
         (SELECT count(*) FROM iso_reference_phase_images WHERE file_url=$1) AS total`,
      [fileUrl]
    );
    let storageWarning = '';
    let storageDeleted = false;
    if (!req.demoMode && fileUrl && Number(refs.rows[0]?.total || 0) === 0) {
      try { await deleteStoredFile(fileUrl, SITE_DIR); storageDeleted = true; }
      catch (storageError) { storageWarning = storageError.message || String(storageError); }
    }
    await recordProductionActivity(req, {
      module:'petri',actionType:'photo_deleted',itemId:photo.petri_id,
      itemLabel:`Petri ID ${photo.petri_id}`,dayIndex:photo.day_index,
      details:{ album_photo_id:photoId,storage_deleted:storageDeleted }
    });
    res.json({ success: true, storage_warning: storageWarning || undefined });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error("DELETE /api/album-photos/:id", e);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

// PUT /api/album-photos/:id/reference
// Définir manuellement une photo d'album comme référence commune du groupe isolement + phase + jour.
app.put("/api/album-photos/:id/reference", async (req, res) => {
  try {
    await ensureReferenceDaySchema();
    const photoId = Number(req.params.id);
    if (!photoId) return res.status(400).json({ success: false, error: "id photo invalide" });

    let photoRes = await pool.query(
      `SELECT * FROM iso_petri_album_photos WHERE id=$1 LIMIT 1`,
      [photoId]
    );
    if (!photoRes.rows.length) return res.status(404).json({ success: false, error: "Photo introuvable" });

    const photo = photoRes.rows[0];
    let phase = Number(photo.phase || 0);
    const dayIndex = Number(photo.day_index || 0);
    if (!phase) return res.status(400).json({ success: false, error: "Phase manquante sur photo album" });

    await upsertDailyReference({
      isolementId: Number(photo.isolement_id),
      phase,
      dayIndex,
      albumPhotoId: Number(photo.id),
      petriId: Number(photo.petri_id),
      fileUrl: String(photo.file_url || ""),
      commentaire: `Référence définie manuellement depuis album — P${phase}-J${dayIndex} — note référence 10`
    });

    res.json({ success: true, reference_group: { isolement_id: Number(photo.isolement_id), phase, day_index: dayIndex } });
  } catch (e) {
    console.error("PUT /api/album-photos/:id/reference", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/journal/image", upload.single("photo"), async (req, res) => {
  try {
    await ensureReferenceDaySchema();
    let id_observation = Number(req.body.id_observation);
    if (!id_observation) return res.status(400).json({ success: false, error: "id_observation manquant" });

    // Hybrid AVIF workflow: the browser can send a final Supabase AVIF URL.
    // Legacy multipart upload remains supported as a fallback while the migration is validated.
    let file_url = String((req.body && req.body.file_url) || "").trim();

    if (file_url) {
      const parsed = parseSupabasePublicObjectUrl(file_url);
      if (!parsed || parsed.bucket !== "isolements" || !/\.avif$/i.test(parsed.objectPath)) {
        return res.status(400).json({
          success: false,
          error: "URL AVIF Petri non autorisee"
        });
      }
    } else {
      if (!req.file) {
        return res.status(400).json({ success: false, error: "photo ou file_url manquant" });
      }

      file_url = await persistUploadedFile({
        file: req.file,
        folder: "isolements",
        filename: req.file.filename || generatedUploadName(req, req.file, "ISOIMG"),
      });
    }

    const cur = await pool.query(
      `SELECT j.id, j.petri_id, j.day_index, j.visual_note20, j.obs,
              p.isolement_id, p.gelose_id, p.phase
       FROM iso_petri_journal j
       JOIN iso_petris p ON p.id = j.petri_id
       WHERE j.id=$1
       LIMIT 1`,
      [id_observation]
    );
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "Observation introuvable" });

    const row = cur.rows[0];
    const petriId = Number(row.petri_id);
    const isolementId = Number(row.isolement_id);
    const phase = Number(row.phase);
    const geloseId = row.gelose_id === null || row.gelose_id === undefined ? null : Number(row.gelose_id);
    let note = Number(row.visual_note20 || 0);

    let albumRes = await pool.query(
      `INSERT INTO iso_petri_album_photos
         (petri_id, isolement_id, gelose_id, phase, journal_observation_id, day_index,
          file_url, note20, remarque, is_reference_candidate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)
       RETURNING *`,
      [
        petriId,
        isolementId,
        geloseId,
        phase,
        id_observation,
        Number(row.day_index || 0),
        file_url,
        note,
        String(row.obs || ""),
      ]
    );
    let albumPhoto = albumRes.rows[0];

    const dayIndex = Number(row.day_index || 0);
    let currentRefRes = await pool.query(
      `SELECT id, note20
       FROM iso_reference_phase_images
       WHERE isolement_id=$1 AND phase=$2 AND day_index=$3
       LIMIT 1`,
      [isolementId, phase, dayIndex]
    );

    // Référence active du groupe = meilleure photo du même isolement + même phase + même jour.
    // Une photo notée > 10 remplace la référence du groupe Pn-Jn.
    let hasReference = currentRefRes.rows.length > 0;
    let becomesReference = !hasReference || note > 10;

    if (becomesReference) {
      await upsertDailyReference({
        isolementId,
        phase,
        dayIndex,
        albumPhotoId: Number(albumPhoto.id),
        petriId,
        fileUrl: file_url,
        commentaire: `Référence commune P${phase}-J${dayIndex} — note référence normalisée à 10`
      });
    }

    let refNowRes = await pool.query(
      `SELECT file_url
       FROM iso_reference_phase_images
       WHERE isolement_id=$1 AND phase=$2 AND day_index=$3
       LIMIT 1`,
      [isolementId, phase, dayIndex]
    );
    let groupReferenceUrl = refNowRes.rows.length ? String(refNowRes.rows[0].file_url || "") : "";

    await pool.query(
      `UPDATE iso_petri_journal
       SET image_url=$1,
           reference_image_url=$3,
           is_reference=$4,
           updated_at=now()
       WHERE id=$2`,
      [file_url, id_observation, groupReferenceUrl, becomesReference]
    );

    await recordProductionActivity(req, {
      module: 'petri', actionType: 'photo_added', itemId: petriId,
      itemLabel: `P${phase} ID ${petriId}`, dayIndex,
      details: { isolement_id: isolementId, journal_id: id_observation, album_photo_id: albumPhoto.id }
    });

    res.json({
      success: true,
      data: {
        file_url,
        album_photo_id: albumPhoto.id,
        is_reference: becomesReference,
        group_reference_url: groupReferenceUrl,
        reference_note20: 10
      }
    });
  } catch (e) {
    console.error("POST /api/journal/image", e);
    res.status(500).json({ success: false, error: e.message });
  }
});


// POST /api/journal/finaliser  (compat: no-op)
app.post("/api/journal/finaliser", async (req, res) => {
  try {
    // Ici tu peux mettre une logique "status final" si tu veux.
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Liste des boîtes P3 VALIDÉES (prêtes pour "Souche interne")
app.get("/api/petri/ready", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        p.id AS petri_id,
        p.id,
        p.isolement_id,
        p.phase,
        p.status,
        p.created_at,
        i.champignon,
        i.categorie,
        i.origine,
        i.code AS souche_mere_id
      FROM iso_petris p
      JOIN isolements i ON i.id = p.isolement_id
      WHERE p.phase = 3
        AND p.status = 'VALIDE'
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("GET /api/petri/ready", e);
    res.status(500).json({ error: e.message });
  }
});

// ✅ Détails d'une boîte (format attendu par admin-souches.html)
app.get("/api/petri/:id", async (req, res) => {
  try {
    const petriId = Number(req.params.id);
    if (!petriId) return res.status(400).json({ error: "id petri invalide" });

    const r = await pool.query(`
      SELECT
        p.id AS petri_id,
        p.id,
        p.isolement_id,
        p.parent_id,
        p.phase,
        p.j0,
        p.status,
        p.created_at,
        i.champignon AS nom,
        i.categorie,
        i.origine AS provenance,
        i.code AS souche_mere_id,
        0::numeric AS quantite
      FROM iso_petris p
      JOIN isolements i ON i.id = p.isolement_id
      WHERE p.id = $1
    `, [petriId]);

    if (!r.rows.length) return res.status(404).json({ error: "Boîte introuvable" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("GET /api/petri/:id", e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// ✅ NOUVEAU : ROUTES SOUCHES (Gestion des souches internes/externes)
// ============================================================




// ============================================================
// TACHES OBLIGATOIRES DU JOUR
// Cette vue ne calcule pas d'objectif de production : elle remonte uniquement
// les contrôles/échéances opérationnels qui demandent une action.
// ============================================================
app.get("/api/tasks/today", async (req, res) => {
  const tasks = [];
  const warnings = [];
  const addTask = (task) => tasks.push({
    id: String(task.id || `${task.category}-${tasks.length + 1}`),
    category: task.category,
    title: task.title,
    subtitle: task.subtitle || "",
    detail: task.detail || "",
    href: task.href || "admin.html",
    severity: task.severity || "today",
    due_label: task.due_label || "Aujourd'hui",
    sort_order: Number(task.sort_order || 50)
  });

  // 1) Souches : échéances proches ou dépassées.
  try {
    const r = await pool.query(`
      SELECT id, code, name, species,
             COALESCE(expiry_on::date, (created_on + INTERVAL '2 years')::date) AS expiry_date,
             (COALESCE(expiry_on::date, (created_on + INTERVAL '2 years')::date) - CURRENT_DATE)::int AS days_left
      FROM strains
      WHERE COALESCE(status::text, 'ACTIVE') <> 'ARCHIVED'
        AND (expiry_on IS NOT NULL OR created_on IS NOT NULL)
        AND COALESCE(expiry_on::date, (created_on + INTERVAL '2 years')::date) <= CURRENT_DATE + 30
      ORDER BY expiry_date ASC
      LIMIT 50
    `);
    for (const x of r.rows || []) {
      const days = Number(x.days_left || 0);
      addTask({
        id: `strain-${x.id}`,
        category: "Souches",
        title: days < 0 ? `Souche arrivée à échéance — ${x.code}` : `Contrôle échéance souche — ${x.code}`,
        subtitle: `${x.name || x.species || 'Souche'}${x.species && x.name ? ' · ' + x.species : ''}`,
        detail: days < 0 ? `Échéance dépassée de ${Math.abs(days)} jour(s). Vérifier le statut et la conservation.` : `Échéance dans ${days} jour(s). Vérifier la conservation et la disponibilité.`,
        href: `admin-souches.html?strain_id=${encodeURIComponent(x.id)}`,
        severity: days < 0 ? "overdue" : (days <= 7 ? "urgent" : "warning"),
        due_label: days < 0 ? "En retard" : (days === 0 ? "Aujourd'hui" : `J-${days}`),
        sort_order: days < 0 ? 1 : 20 + Math.max(0, days)
      });
    }
  } catch (e) {
    warnings.push(`Souches: ${e.message}`);
  }

  // 2) Isolation tissulaire : une boîte active sans observation pour son jour biologique courant.
  try {
    const r = await pool.query(`
      SELECT p.id AS petri_id, p.isolement_id, p.phase, p.status, p.j0,
             i.code AS iso_code, i.champignon,
             GREATEST(0, CURRENT_DATE - p.j0::date)::int AS day_index,
             (SELECT MAX(j.day_index) FROM iso_petri_journal j WHERE j.petri_id=p.id) AS last_day_index
      FROM iso_petris p
      JOIN isolements i ON i.id=p.isolement_id
      WHERE p.j0 IS NOT NULL
        AND p.j0::date <= CURRENT_DATE
        AND UPPER(COALESCE(p.status, 'EN_INCUBATION')) NOT IN
            ('STOCK_FRIGO','CONSERVATION_FRIGORIFIQUE','STOCK','CONSERVATION','VALIDE','PIQUE','PERIME','PERIMEE','SUPPRIME','A_DETRUIRE','CONTAMINE')
        AND NOT EXISTS (
          SELECT 1 FROM iso_petri_journal j
          WHERE j.petri_id=p.id
            AND j.day_index=GREATEST(0, CURRENT_DATE - p.j0::date)::int
        )
      ORDER BY p.j0 ASC, p.phase ASC, p.id ASC
      LIMIT 200
    `);
    for (const x of r.rows || []) {
      const day = Number(x.day_index || 0);
      const last = x.last_day_index == null ? -1 : Number(x.last_day_index);
      const missed = Math.max(0, day - last - 1);
      addTask({
        id: `iso-${x.petri_id}-j${day}`,
        category: "Isolation tissulaire",
        title: `Contrôle boîte P${x.phase} — J${day}`,
        subtitle: `${x.iso_code || 'Isolation'} · ${x.champignon || ''} · boîte #${x.petri_id}`,
        detail: missed > 0 ? `${missed} contrôle(s) antérieur(s) semblent manquer. Renseigner l'observation du jour.` : "Observation quotidienne à renseigner dans le journal de la boîte.",
        href: `admin-isolement-journal.html?iso=${encodeURIComponent(x.isolement_id)}&petri=${encodeURIComponent(x.petri_id)}`,
        severity: missed > 0 ? "overdue" : "today",
        due_label: missed > 0 ? `${missed} retard(s)` : "Aujourd'hui",
        sort_order: missed > 0 ? 2 : 10
      });
    }
  } catch (e) {
    warnings.push(`Isolation: ${e.message}`);
  }

  // 3) Mycélium liquide : un pot actif sans journal au jour biologique courant.
  try {
    const r = await pool.query(`
      SELECT l.id AS lot_id, l.code AS lot_code, p.id AS pot_id, p.pot_number, p.status,
             GREATEST(0, LEAST(18, CURRENT_DATE - COALESCE(l.j0_date, l.created_at::date)))::int AS day_index,
             (SELECT MAX(j.day_index) FROM lc_pot_journal j WHERE j.lc_pot_id=p.id) AS last_day_index
      FROM lc_lots l
      JOIN lc_pots p ON p.lc_lot_id=l.id
      WHERE p.deleted_at IS NULL
        AND COALESCE(l.j0_date, l.created_at::date) <= CURRENT_DATE
        AND UPPER(COALESCE(p.status, 'ACTIF')) NOT IN ('STOCK','UTILISE','SUPPRIME','REJETE','CONTAMINE')
        AND NOT EXISTS (
          SELECT 1 FROM lc_pot_journal j
          WHERE j.lc_pot_id=p.id
            AND j.day_index=GREATEST(0, LEAST(18, CURRENT_DATE - COALESCE(l.j0_date, l.created_at::date)))::int
        )
      ORDER BY COALESCE(l.j0_date, l.created_at::date) ASC, l.id ASC, p.pot_number ASC
      LIMIT 300
    `);
    for (const x of r.rows || []) {
      const day = Number(x.day_index || 0);
      const last = x.last_day_index == null ? -1 : Number(x.last_day_index);
      const missed = Math.max(0, day - last - 1);
      const potNo = String(x.pot_number || '').padStart(2, '0');
      addTask({
        id: `lc-${x.lot_id}-${x.pot_id}-j${day}`,
        category: "Mycélium liquide",
        title: `Journal LC pot ${potNo} — J${day}`,
        subtitle: `${x.lot_code || 'Lot LC'} · pot #${x.pot_id}`,
        detail: day <= 10 ? "Contrôle du jour et agitation/mélange selon le protocole LC." : "Contrôle journalier de croissance, contamination et qualité du pot LC.",
        href: `admin-lc-cycle.html?lc_id=${encodeURIComponent(x.lot_id)}&pot_id=${encodeURIComponent(x.pot_id)}&from_tasks=1`,
        severity: missed > 0 ? "overdue" : "today",
        due_label: missed > 0 ? `${missed} retard(s)` : "Aujourd'hui",
        sort_order: missed > 0 ? 3 : 11
      });
    }
  } catch (e) {
    warnings.push(`Mycélium liquide: ${e.message}`);
  }

  // 4) Mycélium sur grain : unité en incubation sans journal au jour courant.
  try {
    const r = await pool.query(`
      SELECT u.id AS unit_id, u.code AS unit_code, u.statut, u.inoculated_at,
             b.code AS batch_code, b.champignon,
             GREATEST(0, CURRENT_DATE - u.inoculated_at::date)::int AS day_index,
             (SELECT MAX(j.day_index) FROM myc_grain_journal j WHERE j.grain_unit_id=u.id) AS last_day_index
      FROM myc_grain_units u
      JOIN myc_grain_batches b ON b.id=u.batch_id
      WHERE u.inoculated_at IS NOT NULL
        AND UPPER(COALESCE(u.statut, 'ENSEMENCE')) IN ('ENSEMENCE','EN_INCUBATION')
        AND NOT EXISTS (
          SELECT 1 FROM myc_grain_journal j
          WHERE j.grain_unit_id=u.id
            AND j.day_index=GREATEST(0, CURRENT_DATE - u.inoculated_at::date)::int
        )
      ORDER BY u.inoculated_at ASC, u.id ASC
      LIMIT 300
    `);
    for (const x of r.rows || []) {
      const day = Number(x.day_index || 0);
      const last = x.last_day_index == null ? -1 : Number(x.last_day_index);
      const missed = Math.max(0, day - last - 1);
      addTask({
        id: `grain-${x.unit_id}-j${day}`,
        category: "Mycélium sur grain",
        title: `Contrôle grain — J${day}`,
        subtitle: `${x.unit_code || 'Pot/sac grain'} · ${x.batch_code || ''}${x.champignon ? ' · ' + x.champignon : ''}`,
        detail: "Vérifier propagation, contamination, température et renseigner le journal de l'unité.",
        href: `admin-myc-grain-journal.html?grain_unit_id=${encodeURIComponent(x.unit_id)}&from_tasks=1`,
        severity: missed > 0 ? "overdue" : "today",
        due_label: missed > 0 ? `${missed} retard(s)` : "Aujourd'hui",
        sort_order: missed > 0 ? 4 : 12
      });
    }
  } catch (e) {
    warnings.push(`Mycélium sur grain: ${e.message}`);
  }

  tasks.sort((a, b) => a.sort_order - b.sort_order || String(a.category).localeCompare(String(b.category), 'fr'));
  const counts = tasks.reduce((acc, t) => {
    acc.total += 1;
    acc[t.category] = (acc[t.category] || 0) + 1;
    if (t.severity === "overdue" || t.severity === "urgent") acc.urgent += 1;
    return acc;
  }, { total: 0, urgent: 0 });

  res.json({
    generated_at: new Date().toISOString(),
    role: req.adminSession && req.adminSession.role || "admin",
    demo: !!req.demoMode,
    counts,
    tasks,
    warnings
  });
});


// GET /api/ping
// Diagnostic simple pour vérifier depuis mobile que le serveur local répond.
app.get("/api/ping", async (req, res) => {
  try {
    let db = await pool.query("SELECT NOW() AS now");
    res.json({ success: true, server: "ok", db: "ok", now: db.rows[0].now });
  } catch (e) {
    res.status(500).json({ success: false, server: "ok", db: "error", error: e.message });
  }
});




// GET /api/scan/resolve?code=...
// Formats acceptés :
//   300
//   P300
//   ISO-80-P300
//   /p/300
//   https://dashboard-wine-tau-15.vercel.app/p/300
app.get("/api/scan/resolve", async (req, res) => {
  try {
    let code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Code QR manquant"
      });
    }

    // Ne change pas la logique historique de recherche.
    // On convertit seulement les nouveaux formats de lien vers un code historique.
    code = code.replace(/[\r\n\t]+/g, "").trim();

    // Lien complet :
    // https://dashboard-wine-tau-15.vercel.app/p/300
    // https://dashboard-wine-tau-15.vercel.app/admin-isolement-journal.html?iso=80&petri=300
    if (/^https?:\/\//i.test(code)) {
      try {
        const u = new URL(code);
        const shortMatch = u.pathname.match(/^\/p\/(\d+)\/?$/i);

        if (shortMatch) {
          code = shortMatch[1];
        } else {
          const petriParam = u.searchParams.get("petri");
          const isoParam = u.searchParams.get("iso");
          const codeParam = u.searchParams.get("code");

          if (petriParam && /^\d+$/.test(petriParam)) {
            code = isoParam && /^\d+$/.test(isoParam)
              ? `ISO-${isoParam}-P${petriParam}`
              : petriParam;
          } else if (codeParam) {
            code = codeParam;
          }
        }
      } catch (_) {}
    }

    // Lien complet sans protocole :
    // dashboard-wine-tau-15.vercel.app/p/300
    const hostShortMatch = String(code).match(/^(?:www\.)?[^\/\s]+\/p\/(\d+)\/?$/i);
    if (hostShortMatch) code = hostShortMatch[1];

    // Lien court : /p/300 ou p/300.
    const relativeShortMatch = String(code).match(/^\/?p\/(\d+)\/?$/i);
    if (relativeShortMatch) code = relativeShortMatch[1];

    // Lien direct relatif vers le journal.
    if (/admin-isolement-journal\.html\?/i.test(String(code))) {
      try {
        const u = new URL(String(code), "https://dashboard-wine-tau-15.vercel.app");
        const petriParam = u.searchParams.get("petri");
        const isoParam = u.searchParams.get("iso");
        if (petriParam && /^\d+$/.test(petriParam)) {
          code = isoParam && /^\d+$/.test(isoParam)
            ? `ISO-${isoParam}-P${petriParam}`
            : petriParam;
        }
      } catch (_) {}
    }

    // Logique historique inchangée à partir d'ici.
    code = String(code)
      .replace(/\s+/g, "")
      .replace(/^box:/i, "")
      .replace(/^boite:/i, "")
      .replace(/^qr:/i, "");

    let isoId = null;
    let petriId = null;

    let m = code.match(/^ISO-(\d+)-P(\d+)$/i);

    if (m) {
      isoId = Number(m[1]);
      petriId = Number(m[2]);
    } else {
      m = code.match(/^P?(\d+)$/i);
      if (m) petriId = Number(m[1]);
    }

    if (!petriId) {
      return res.status(400).json({
        success: false,
        error: "Format QR invalide",
        code_recu: code
      });
    }

    const sql = isoId
      ? `SELECT id, isolement_id, phase, status, j0
         FROM iso_petris
         WHERE id=$1 AND isolement_id=$2
         LIMIT 1`
      : `SELECT id, isolement_id, phase, status, j0
         FROM iso_petris
         WHERE id=$1
         LIMIT 1`;

    const params = isoId
      ? [petriId, isoId]
      : [petriId];

    const r = await pool.query(sql, params);

    if (!r.rows.length) {
      return res.status(404).json({
        success: false,
        error: "Boîte introuvable",
        code_recu: code
      });
    }

    const petri = r.rows[0];

    if (["STOCK_FRIGO", "CONSERVATION_FRIGORIFIQUE", "STOCK", "CONSERVATION"].includes(String(petri.status || "").toUpperCase())) {
      return res.json({
        success: true,
        redirect_url:
          `/admin-isolement-journal.html?iso=${petri.isolement_id}&petri=${petri.id}`
      });
    }

    return res.json({
      success: true,
      box_id: `ISO-${petri.isolement_id}-P${petri.id}`,
      redirect_url:
        `/admin-isolement-journal.html?iso=${petri.isolement_id}&petri=${petri.id}`
    });

  } catch (e) {
    console.error("GET /api/scan/resolve", e);

    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

// ============================================================
// HYBRID LAB IMAGE PIPELINE
// Browser -> signed Supabase temporary upload -> Edge AVIF conversion.
// The binary image never passes through this Vercel/Express function.
// ============================================================
const MEDIA_KINDS = new Set(["petri", "lc", "grain"]);
const MEDIA_INPUT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif"]);
const MEDIA_MAX_TEMP_BYTES = 5 * 1024 * 1024;

function validateMediaKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!MEDIA_KINDS.has(kind)) throw new Error("Type media invalide: petri, lc ou grain attendu");
  return kind;
}

function validateTemporaryMediaPath(kind, value) {
  const sourcePath = String(value || "").trim().replace(/\\/g, "/");
  if (!sourcePath || sourcePath.includes("..") || sourcePath.startsWith("/") || !sourcePath.startsWith(`${kind}/`)) {
    throw new Error("Chemin temporaire media invalide");
  }
  return sourcePath;
}

app.post("/api/media/sign-upload", async (req, res) => {
  try {
    const kind = validateMediaKind(req.body && req.body.kind);
    const originalName = String((req.body && req.body.filename) || "photo.jpg");
    const contentType = String((req.body && req.body.contentType) || "").toLowerCase();
    const size = Number((req.body && req.body.size) || 0);

    let ext = path.extname(originalName).toLowerCase();
    if (!MEDIA_INPUT_EXTENSIONS.has(ext)) ext = ".jpg";

    if (contentType && !contentType.startsWith("image/")) {
      return res.status(400).json({ success: false, error: "Le fichier doit etre une image" });
    }
    if (size && (!Number.isFinite(size) || size < 1 || size > MEDIA_MAX_TEMP_BYTES)) {
      return res.status(413).json({
        success: false,
        error: "Image temporaire trop volumineuse. Maximum 5 MB apres preparation navigateur."
      });
    }

    const tempPath = `${kind}/${Date.now()}-${crypto.randomUUID()}${ext}`;
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from("incoming-media")
      .createSignedUploadUrl(tempPath, { upsert: false });

    if (error) throw new Error(`Creation URL upload Supabase impossible: ${error.message}`);
    if (!data || !data.token) throw new Error("Token upload Supabase manquant");

    return res.json({
      success: true,
      bucket: "incoming-media",
      path: tempPath,
      token: data.token
    });
  } catch (e) {
    console.error("POST /api/media/sign-upload", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/media/process", async (req, res) => {
  try {
    const kind = validateMediaKind(req.body && req.body.kind);
    const sourcePath = validateTemporaryMediaPath(kind, req.body && req.body.sourcePath);

    // Final AVIF profiles. The browser already performs a first resize/compression,
    // and Sharp applies a second safety resize before AVIF encoding.
    const profiles = {
      petri: {
        bucket: "isolements",
        prefix: "ISOIMG",
        maxDimension: 2560,
        quality: 68,
      },
      lc: {
        bucket: "lc",
        prefix: "LCIMG",
        maxDimension: 2048,
        quality: 64,
      },
      grain: {
        bucket: "grain",
        prefix: "GRAINIMG",
        maxDimension: 2048,
        quality: 64,
      },
    };

    const profile = profiles[kind];
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("Client Supabase serveur indisponible");

    console.log(`[AVIF] Download incoming-media/${sourcePath}`);

    // 1) Download the temporary browser upload directly from Supabase Storage.
    const { data: sourceFile, error: downloadError } = await supabase.storage
      .from("incoming-media")
      .download(sourcePath);

    if (downloadError || !sourceFile) {
      throw new Error(
        `Telechargement temporaire impossible: ${
          (downloadError && downloadError.message) || "fichier introuvable"
        }`
      );
    }

    const inputBuffer = Buffer.from(await sourceFile.arrayBuffer());
    if (!inputBuffer.length) throw new Error("Image temporaire vide");

    console.log(`[AVIF] Source ${kind}: ${Math.round(inputBuffer.length / 1024)} KB`);

    // 2) Convert in the Vercel Node.js runtime with Sharp.
    // rotate() applies EXIF orientation. Metadata is stripped by default.
    // effort: 1 keeps AVIF encoding fast enough for a serverless request.
    const { data: avifBuffer, info } = await sharp(inputBuffer, {
      failOn: "none",
      limitInputPixels: 100000000,
    })
      .rotate()
      .resize({
        width: profile.maxDimension,
        height: profile.maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .avif({
        quality: profile.quality,
        effort: 1,
        chromaSubsampling: "4:2:0",
      })
      .toBuffer({ resolveWithObject: true });

    if (!avifBuffer || !avifBuffer.length) {
      throw new Error("Conversion AVIF vide");
    }

    console.log(
      `[AVIF] Converted ${kind}: ${info.width || "?"}x${info.height || "?"}, ` +
      `${Math.round(avifBuffer.length / 1024)} KB`
    );

    // 3) Generate a unique permanent .avif filename.
    const timestamp = new Date()
      .toISOString()
      .replace(/\D/g, "")
      .slice(0, 14);
    const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const finalName = `${profile.prefix}-${timestamp}-${random}.avif`;

    // 4) Upload the permanent AVIF to the existing final bucket.
    const { error: uploadError } = await supabase.storage
      .from(profile.bucket)
      .upload(finalName, avifBuffer, {
        contentType: "image/avif",
        cacheControl: "31536000",
        upsert: false,
      });

    if (uploadError) {
      // Keep the temporary source if the permanent upload failed.
      throw new Error(`Upload AVIF impossible: ${uploadError.message}`);
    }

    const { data: publicData } = supabase.storage
      .from(profile.bucket)
      .getPublicUrl(finalName);

    const fileUrl = publicData && publicData.publicUrl;
    if (!fileUrl || !/\.avif(?:$|\?)/i.test(String(fileUrl))) {
      // The final file exists, so do not delete the temporary source here.
      throw new Error("Impossible de generer une URL publique AVIF valide");
    }

    // 5) Delete the temporary original only AFTER the final AVIF exists.
    const { error: removeError } = await supabase.storage
      .from("incoming-media")
      .remove([sourcePath]);

    if (removeError) {
      // Do not fail the request: the permanent AVIF has already been saved.
      console.warn(
        `[AVIF] Temporary file not deleted incoming-media/${sourcePath}:`,
        removeError.message
      );
    }

    console.log(`[AVIF] Final ${kind}: ${fileUrl}`);

    return res.json({
      success: true,
      kind,
      bucket: profile.bucket,
      filename: finalName,
      file_url: fileUrl,
      width: info.width || null,
      height: info.height || null,
      original_size: inputBuffer.length,
      avif_size: avifBuffer.length,
    });
  } catch (e) {
    console.error("POST /api/media/process", e);
    return res.status(500).json({
      success: false,
      error: (e && e.message) || String(e),
    });
  }
});


// ============================================================
// PETRI QR SHORT LINK
// Example:
// /p/52
// redirects to:
// /admin-isolement-journal.html?iso=261&petri=52
// ============================================================

app.get("/p/:id", async (req, res) => {
  try {
    const petriId = Number(req.params.id || 0);

    if (!petriId) {
      return res
        .status(400)
        .send("Identifiant Petri invalide");
    }

    const result = await pool.query(
      `
      SELECT
        id,
        isolement_id
      FROM iso_petris
      WHERE id = $1
      LIMIT 1
      `,
      [petriId]
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .send("Boîte de Petri introuvable");
    }

    const petri = result.rows[0];

    return res.redirect(
      302,
      `/admin-isolement-journal.html?iso=${encodeURIComponent(
        petri.isolement_id
      )}&petri=${encodeURIComponent(
        petri.id
      )}`
    );

  } catch (error) {
    console.error(
      "GET /p/:id",
      error
    );

    return res
      .status(500)
      .send(
        "Erreur ouverture du journal Petri"
      );
  }
});

module.exports = app;

// Local development only. Vercel imports the Express application directly.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mycelium Tech Digital backend: http://localhost:${PORT}`);
    console.log("Static folder:", STATIC_DIR);
  });
}
