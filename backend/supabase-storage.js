const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const STORAGE_BUCKETS = new Set(['isolements', 'lc', 'grain', 'certificates']);

function isVercelRuntime() {
  return Boolean(process.env.VERCEL);
}

function getSupabaseSecretKey() {
  return String(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
}

function hasSupabaseStorageConfig() {
  return Boolean(String(process.env.SUPABASE_URL || '').trim() && getSupabaseSecretKey());
}

// On Vercel we always keep uploads in memory because the deployment filesystem
// is not persistent. persistUploadedFile() then sends the bytes to Supabase.
function shouldUseCloudStorage() {
  return isVercelRuntime() || hasSupabaseStorageConfig();
}

function safeExtension(originalName, fallback = '.bin') {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  return ext && /^[.a-z0-9_-]{1,12}$/i.test(ext) ? ext : fallback;
}

let supabaseAdmin = null;
function getSupabaseAdmin() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = getSupabaseSecretKey();
  if (!url || !key) {
    throw new Error('Supabase Storage non configure: SUPABASE_URL et SUPABASE_SECRET_KEY sont requis.');
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return supabaseAdmin;
}

function normalizeBucket(folder) {
  const bucket = String(folder || '').trim().toLowerCase();
  if (!STORAGE_BUCKETS.has(bucket)) {
    throw new Error(`Bucket Supabase non autorise: ${bucket || '(vide)'}`);
  }
  return bucket;
}

function safeObjectName(filename) {
  return String(filename || `upload-${Date.now()}.bin`)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');
}

async function persistUploadedFile({ file, folder, filename }) {
  if (!file) throw new Error('Fichier manquant');

  const bucket = normalizeBucket(folder);
  const safeName = safeObjectName(
    filename || file.filename || `upload-${Date.now()}${safeExtension(file.originalname)}`
  );

  if (file.buffer) {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage
      .from(bucket)
      .upload(safeName, file.buffer, {
        contentType: file.mimetype || undefined,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) throw new Error(`Upload Supabase (${bucket}) impossible: ${error.message}`);

    const { data } = supabase.storage.from(bucket).getPublicUrl(safeName);
    if (!data || !data.publicUrl) {
      throw new Error(`URL publique Supabase introuvable pour ${bucket}/${safeName}`);
    }
    return data.publicUrl;
  }

  // Local development fallback when Supabase variables are not configured.
  if (file.filename) return `/uploads/${bucket}/${file.filename}`;
  throw new Error('Upload invalide');
}

function parseSupabasePublicObjectUrl(fileUrl) {
  try {
    const configuredUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!configuredUrl) return null;
    const expectedOrigin = new URL(configuredUrl).origin;
    const url = new URL(String(fileUrl || ''));
    if (url.origin !== expectedOrigin) return null;

    const marker = '/storage/v1/object/public/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;

    const remainder = decodeURIComponent(url.pathname.slice(index + marker.length));
    const slash = remainder.indexOf('/');
    if (slash <= 0) return null;

    const bucket = remainder.slice(0, slash);
    const objectPath = remainder.slice(slash + 1);
    if (!STORAGE_BUCKETS.has(bucket) || !objectPath) return null;
    return { bucket, objectPath };
  } catch (_) {
    return null;
  }
}

async function deleteStoredFile(fileUrl, siteDir) {
  const value = String(fileUrl || '').trim();
  if (!value) return;

  const object = parseSupabasePublicObjectUrl(value);
  if (object) {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(object.bucket).remove([object.objectPath]);
    if (error) throw new Error(`Suppression Supabase impossible: ${error.message}`);
    return;
  }

  // Local development fallback.
  if (!/^https?:\/\//i.test(value)) {
    try {
      const diskPath = path.join(siteDir, value.replace(/^\//, ''));
      if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    } catch (_) {}
  }
}

async function deleteDemoSupabaseFiles(sid) {
  if (!hasSupabaseStorageConfig() || !sid) return;

  const prefix = `DEMO-${String(sid)}-`;
  const supabase = getSupabaseAdmin();

  for (const bucket of STORAGE_BUCKETS) {
    let offset = 0;
    const batchSize = 1000;
    do {
      const { data, error } = await supabase.storage.from(bucket).list('', {
        limit: batchSize,
        offset,
        sortBy: { column: 'name', order: 'asc' },
        search: prefix,
      });
      if (error) {
        console.warn(`Nettoyage Supabase demo impossible (${bucket}):`, error.message);
        break;
      }

      const paths = (data || [])
        .filter((item) => item && item.id !== null && String(item.name || '').startsWith(prefix))
        .map((item) => item.name);

      if (paths.length) {
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
        if (removeError) {
          console.warn(`Suppression Supabase demo impossible (${bucket}):`, removeError.message);
          break;
        }
      }

      if (!data || data.length < batchSize) break;
      offset += batchSize;
    } while (true);
  }
}

module.exports = {
  STORAGE_BUCKETS,
  deleteDemoSupabaseFiles,
  deleteStoredFile,
  getSupabaseAdmin,
  hasSupabaseStorageConfig,
  isVercelRuntime,
  parseSupabasePublicObjectUrl,
  persistUploadedFile,
  safeExtension,
  shouldUseCloudStorage,
};
