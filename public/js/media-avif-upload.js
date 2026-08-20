(function () {
  "use strict";

  console.log("🔄 Initialisation module AVIF...");

  // ============================================================
  // MYCELIUM TECH DIGITAL
  // Shared image pipeline:
  //
  // Browser resize
  //   -> signed upload
  //   -> Supabase incoming-media
  //   -> Edge Function
  //   -> final AVIF
  // ============================================================

  const SUPABASE_URL =
    "https://ikomtseunfwffcghnifr.supabase.co";

  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_9rFYPKIZmlh83tMr4aVfHQ_wnbGM63N";

  const MB = 1024 * 1024;

  const PROFILES = {
    petri: {
      maxDimension: 2560
    },

    lc: {
      maxDimension: 2048
    },

    grain: {
      maxDimension: 2048
    }
  };

  let supabaseClient = null;

  // ============================================================
  // SUPABASE CLIENT
  // ============================================================

  function getSupabaseClient() {

    if (supabaseClient) {
      return supabaseClient;
    }

    if (
      !window.supabase ||
      typeof window.supabase.createClient !== "function"
    ) {
      throw new Error(
        "Bibliothèque Supabase JS non chargée"
      );
    }

    supabaseClient =
      window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        }
      );

    return supabaseClient;
  }

  // ============================================================
  // FETCH JSON
  // ============================================================

  async function fetchJson(url, options) {

    const response =
      await fetch(
        url,
        {
          credentials: "same-origin",
          ...(options || {})
        }
      );

    const raw =
      await response.text();

    let data = {};

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = null;
      }
    }

    if (!response.ok) {

      if (data && data.error) {
        throw new Error(data.error);
      }

      if (data && data.message) {
        throw new Error(data.message);
      }

      throw new Error(
        raw ||
        response.statusText ||
        "HTTP " + response.status
      );
    }

    return data || {};
  }

  // ============================================================
  // BROWSER PREPROCESSING
  // ============================================================

  async function preprocessLabImage(
    file,
    kind
  ) {

    if (!file) {
      throw new Error(
        "Aucune photo sélectionnée."
      );
    }

    const mime =
      String(file.type || "")
        .toLowerCase();

    if (
      !mime.startsWith("image/")
    ) {
      throw new Error(
        "Le fichier sélectionné n'est pas une image."
      );
    }

    const profile =
      PROFILES[kind];

    if (!profile) {
      throw new Error(
        "Type média invalide : " + kind
      );
    }

    // ----------------------------------------------------------
    // HEIC / HEIF:
    // do not attempt browser decoding.
    // Send original to Edge Function.
    // ----------------------------------------------------------

    if (
      mime === "image/heic" ||
      mime === "image/heif"
    ) {

      console.log(
        "📱 Image HEIC/HEIF : envoi original vers conversion serveur."
      );

      return file;
    }

    let bitmap;

    try {

      bitmap =
        await createImageBitmap(
          file,
          {
            imageOrientation:
              "from-image"
          }
        );

    } catch (error) {

      console.warn(
        "⚠️ Prétraitement navigateur impossible. Original conservé.",
        error
      );

      return file;
    }

    const originalWidth =
      bitmap.width;

    const originalHeight =
      bitmap.height;

    const largestDimension =
      Math.max(
        originalWidth,
        originalHeight
      );

    const scale =
      Math.min(
        1,
        profile.maxDimension /
          largestDimension
      );

    // Small image:
    // leave it untouched.
    if (
      scale === 1 &&
      file.size <= 2 * MB
    ) {

      bitmap.close();

      console.log(
        "ℹ️ Image déjà suffisamment petite."
      );

      return file;
    }

    const outputWidth =
      Math.max(
        1,
        Math.round(
          originalWidth *
          scale
        )
      );

    const outputHeight =
      Math.max(
        1,
        Math.round(
          originalHeight *
          scale
        )
      );

    console.log(
      "📐 Redimensionnement:",
      originalWidth + "x" + originalHeight,
      "→",
      outputWidth + "x" + outputHeight
    );

    const canvas =
      document.createElement(
        "canvas"
      );

    canvas.width =
      outputWidth;

    canvas.height =
      outputHeight;

    const ctx =
      canvas.getContext(
        "2d",
        {
          alpha: false
        }
      );

    if (!ctx) {

      bitmap.close();

      return file;
    }

    // Laboratory photos do not need alpha.
    ctx.fillStyle =
      "#ffffff";

    ctx.fillRect(
      0,
      0,
      outputWidth,
      outputHeight
    );

    ctx.drawImage(
      bitmap,
      0,
      0,
      outputWidth,
      outputHeight
    );

    bitmap.close();

    const compressedBlob =
      await new Promise(
        function (resolve) {

          canvas.toBlob(
            resolve,
            "image/webp",
            0.86
          );

        }
      );

    if (!compressedBlob) {

      console.warn(
        "⚠️ Compression navigateur impossible."
      );

      return file;
    }

    // If nothing useful was gained,
    // retain original.
    if (
      scale === 1 &&
      compressedBlob.size >=
        file.size
    ) {

      return file;
    }

    const baseName =
      String(
        file.name ||
        "photo"
      ).replace(
        /\.[^.]+$/,
        ""
      );

    const prepared =
      new File(
        [compressedBlob],
        baseName + ".webp",
        {
          type:
            "image/webp",

          lastModified:
            Date.now()
        }
      );

    console.log(
      "📦 Photo navigateur:",
      Math.round(
        file.size /
        1024
      ),
      "KB →",
      Math.round(
        prepared.size /
        1024
      ),
      "KB"
    );

    return prepared;
  }

  // ============================================================
  // MAIN UPLOAD FUNCTION
  // ============================================================

  async function uploadLabImage(
    file,
    kind,
    onStatus,
    metadata
  ) {


metadata =
  metadata &&
  typeof metadata === "object"
    ? metadata
    : {};


    if (!PROFILES[kind]) {

      throw new Error(
        "Type image invalide : " +
        kind
      );

    }

    const status =
      typeof onStatus ===
      "function"
        ? onStatus
        : function () {};

    // ----------------------------------------------------------
    // 1 - Browser preprocessing
    // ----------------------------------------------------------

    status(
      "Préparation de la photo..."
    );

    const preparedFile =
      await preprocessLabImage(
        file,
        kind
      );

    if (
      preparedFile.size >
      10 * MB
    ) {

      throw new Error(
        "La photo reste supérieure à 10 MB après préparation."
      );

    }

    // ----------------------------------------------------------
    // 2 - Ask backend for signed upload token
    // ----------------------------------------------------------

    status(
      "Création upload sécurisé..."
    );

    const signed =
      await fetchJson(
        "/api/media/sign-upload",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Accept":
              "application/json"
          },

          body:
            JSON.stringify({
              kind:
                kind,

              filename:
                preparedFile.name ||
                file.name ||
                "photo.jpg",

              contentType:
                preparedFile.type ||
                file.type ||
                "application/octet-stream",

              size:
                preparedFile.size,
                entityId: 
                metadata.entityId || null
            })
        }
      );

    if (!signed.path) {

      throw new Error(
        "Chemin upload Supabase manquant."
      );

    }

    if (!signed.token) {

      throw new Error(
        "Token upload Supabase manquant."
      );

    }

    // ----------------------------------------------------------
    // 3 - DIRECT browser -> Supabase
    // ----------------------------------------------------------

    status(
      "Envoi temporaire vers Supabase..."
    );

    const client =
      getSupabaseClient();

    const bucket =
      signed.bucket ||
      "incoming-media";

    const uploadResult =
      await client
        .storage
        .from(bucket)
        .uploadToSignedUrl(
          signed.path,
          signed.token,
          preparedFile,
          {
            contentType:
              preparedFile.type ||
              "application/octet-stream"
          }
        );

    if (
      uploadResult.error
    ) {

      throw new Error(
        "Upload Supabase impossible : " +
        uploadResult.error.message
      );

    }

    console.log(
      "✅ Upload temporaire:",
      bucket +
      "/" +
      signed.path
    );

    // ----------------------------------------------------------
    // 4 - Trigger AVIF Edge Function through backend
    // ----------------------------------------------------------

    status(
      "Conversion en AVIF..."
    );

    const processed =
      await fetchJson(
        "/api/media/process",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Accept":
              "application/json"
          },

          body:
  JSON.stringify({
    kind: kind,

    sourcePath:
      signed.path,

    entityId:
      metadata.entityId || null
  })
        }
      );

    if (
      !processed.file_url
    ) {

      throw new Error(
        "Conversion AVIF terminée sans file_url."
      );

    }

    console.log(
      "✅ AVIF final:",
      processed.file_url
    );

    if (
      !/\.avif(?:$|\?)/i.test(
        processed.file_url
      )
    ) {

      console.warn(
        "⚠️ L'URL finale ne se termine pas par .avif:",
        processed.file_url
      );

    }

    status(
      "Photo optimisée ✓"
    );

    return {
      ...processed,

      original_size:
        file.size,

      temporary_size:
        preparedFile.size
    };
  }

  // ============================================================
  // PUBLIC BROWSER API
  // ============================================================

  window.preprocessLabImage =
    preprocessLabImage;

  window.uploadLabImage =
    uploadLabImage;

  console.log(
    "✅ Module AVIF prêt - uploadLabImage disponible"
  );

})();