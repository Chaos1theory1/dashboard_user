import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
} from "npm:@imagemagick/magick-wasm@^0";

const wasmBytes = await Deno.readFile(
  new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@^0"))
);
await initializeImageMagick(wasmBytes);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const MEDIA_PIPELINE_SECRET = Deno.env.get("MEDIA_PIPELINE_SECRET") || "";

function getAdminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return String(parsed.default);
      const first = Object.values(parsed || {}).find(Boolean);
      if (first) return String(first);
    } catch (_) {}
  }
  throw new Error("Aucune cle Supabase serveur disponible dans l'Edge Function");
}

const supabase = createClient(SUPABASE_URL, getAdminKey(), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const PROFILES = {
  petri: { bucket: "isolements", prefix: "ISOIMG", maxDimension: 2560, quality: 68 },
  lc: { bucket: "lc", prefix: "LCIMG", maxDimension: 2048, quality: 64 },
  grain: { bucket: "grain", prefix: "GRAINIMG", maxDimension: 2048, quality: 64 },
} as const;

type MediaKind = keyof typeof PROFILES;

function createFilename(prefix: string) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}.avif`;
}

function safeSourcePath(kind: string, value: unknown) {
  const path = String(value || "").trim().replace(/\\/g, "/");
  if (!path || path.includes("..") || path.startsWith("/") || !path.startsWith(`${kind}/`)) {
    throw new Error("sourcePath temporaire invalide");
  }
  return path;
}

Deno.serve(async (req) => {
  try {
    if (!MEDIA_PIPELINE_SECRET) {
      return Response.json({ success: false, error: "MEDIA_PIPELINE_SECRET non configure" }, { status: 503 });
    }
    if (req.headers.get("x-media-secret") !== MEDIA_PIPELINE_SECRET) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (req.method !== "POST") {
      return Response.json({ success: false, error: "Method not allowed" }, { status: 405 });
    }

    const body = await req.json();
    const kind = String(body?.kind || "").toLowerCase() as MediaKind;
    const profile = PROFILES[kind];
    if (!profile) return Response.json({ success: false, error: "Invalid media type" }, { status: 400 });
    const sourcePath = safeSourcePath(kind, body?.sourcePath);

    const { data: sourceFile, error: downloadError } = await supabase.storage
      .from("incoming-media")
      .download(sourcePath);
    if (downloadError || !sourceFile) {
      throw new Error(`Image temporaire introuvable: ${downloadError?.message || "download failed"}`);
    }

    const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer());
    if (sourceBytes.byteLength > 5 * 1024 * 1024) {
      throw new Error("Image temporaire superieure a 5 MB. Le pretraitement navigateur doit la reduire.");
    }

    const avifBytes = ImageMagick.read(sourceBytes, (image): Uint8Array => {
      image.autoOrient();
      const largest = Math.max(image.width, image.height);
      if (largest > profile.maxDimension) {
        const ratio = profile.maxDimension / largest;
        const width = Math.max(1, Math.round(image.width * ratio));
        const height = Math.max(1, Math.round(image.height * ratio));
        image.resize(width, height);
      }
      image.quality = profile.quality;
      return image.write(MagickFormat.Avif, (data) => Uint8Array.from(data));
    });

    if (!avifBytes || avifBytes.byteLength < 1) throw new Error("Encodeur AVIF n'a produit aucune donnee");

    const finalName = createFilename(profile.prefix);
    const { error: uploadError } = await supabase.storage
      .from(profile.bucket)
      .upload(finalName, avifBytes, {
        contentType: "image/avif",
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadError) throw new Error(`Upload AVIF (${profile.bucket}) impossible: ${uploadError.message}`);

    const { data: publicData } = supabase.storage.from(profile.bucket).getPublicUrl(finalName);
    if (!publicData?.publicUrl) throw new Error("URL publique AVIF introuvable");

    const { error: cleanupError } = await supabase.storage.from("incoming-media").remove([sourcePath]);
    const savings = sourceBytes.byteLength > 0
      ? Math.max(0, Math.round((1 - avifBytes.byteLength / sourceBytes.byteLength) * 100))
      : 0;

    return Response.json({
      success: true,
      bucket: profile.bucket,
      filename: finalName,
      file_url: publicData.publicUrl,
      input_bytes: sourceBytes.byteLength,
      avif_bytes: avifBytes.byteLength,
      savings_percent: savings,
      cleanup_warning: cleanupError ? cleanupError.message : null,
    });
  } catch (error) {
    console.error("convert-image-avif", error);
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
});
