/**
 * Routes API pour la gestion des souches
 * Backend Node.js/Express pour BaslyAgro.Biotech
 * VERSION FINALE - Structure base de données vérifiée
 * 
 * STRUCTURE RÉELLE CONFIRMÉE:
 * - isolements (id, code, champignon, categorie, origine)
 * - iso_petris (id, isolement_id, phase, j0, status, gelose_id)
 * - iso_geloses (id, isolement_id, nom, recette)
 * - strains (id UUID, code, species, name, etc.)
 */
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { deleteStoredFile, persistUploadedFile, safeExtension, shouldUseCloudStorage } = require('../supabase-storage');


const express = require('express');
const router = express.Router();

// ============================================================
// ROUTES DE BASE - GESTION DES SOUCHES
// ============================================================
function certificateFilename(req, file) {
  const ext = safeExtension(file && file.originalname, '.pdf');
  const demoPrefix = req.adminSession && req.adminSession.role === 'visitor' && req.adminSession.sid
    ? `DEMO-${req.adminSession.sid}-`
    : '';
  return `${demoPrefix}STRAIN-${req.params.id}-${Date.now()}${ext}`;
}

const storage = shouldUseCloudStorage()
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/certificates');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, certificateFilename(req, file))
    });

const upload = multer({
  storage,
  limits: { fileSize: process.env.VERCEL ? 4 * 1024 * 1024 : 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Seuls les fichiers PDF sont autorisés'));
    }
    cb(null, true);
  }
});
router.post(
  '/strains/:id/certify',
  upload.single('certificate_pdf'),
  async (req, res) => {
    const {
      certificate_ref,
      certified_by,
      contamination_status,
      contamination_type,
      growth_rate,
      colonization_days,
      morphology_status,
      decision,
      notes
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Certificat PDF manquant' });
    }

    if (decision !== 'PASS') {
      return res.status(400).json({ error: 'La certification doit être PASS' });
    }

    let pdfPath = null;
    try {
      pdfPath = await persistUploadedFile({
        file: req.file,
        folder: 'certificates',
        filename: req.file.filename || certificateFilename(req, req.file),
      });
      await req.db.query('BEGIN');

      // 1️⃣ Enregistrer le certificat
      await req.db.query(
        `
        INSERT INTO strain_certificates (
          strain_id,
          certificate_ref,
          certified_by,
          contamination_status,
          contamination_type,
          growth_rate,
          colonization_days,
          morphology_status,
          decision,
          notes,
          pdf_path
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          req.params.id,
          certificate_ref,
          certified_by,
          contamination_status,
          contamination_type || null,
          growth_rate || null,
          colonization_days || null,
          morphology_status || null,
          decision,
          notes || null,
          pdfPath
        ]
      );

      // 2️⃣ Mettre à jour la souche
      await req.db.query(
        `
        UPDATE strains
        SET
          certificate_available = true,
          certification_status = 'CERTIFIED',
          production_allowed = true
        WHERE id = $1
        `,
        [req.params.id]
      );

      await req.db.query('COMMIT');

      res.json({ success: true });
    } catch (error) {
      try { await req.db.query('ROLLBACK'); } catch (_) {}
      if (pdfPath) await deleteStoredFile(pdfPath, path.join(__dirname, '../..'));
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * 
 * 
 * 
 * 
 * 
 * 
 * GET /api/strains
 * Liste toutes les souches avec pagination
 */
router.get('/strains', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await req.db.query(
      `SELECT 
        id, code, species, name, strain_type, form,
        source_name, source_ref,
        quantity, unit,
        created_on, manufactured_on, expiry_on,
        storage_temp_c, storage_location,
        status, certificate_available, certification_status, 
        production_allowed, created_at, updated_at
      FROM strains
      WHERE status != 'ARCHIVED'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/strains:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des souches' });
  }
});

router.get('/strains/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      'SELECT * FROM strains WHERE id = $1::UUID',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/strains/:id:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la souche' });
  }
});

router.post('/strains', async (req, res) => {
  const {
    code,
    name,
    species,
    strain_type,
    form = 'AGAR',
    source_name,
    source_ref,
    quantity,
    unit,
    created_on,
    manufactured_on,
    expiry_on,
    storage_temp_c,
    storage_location,
    status = 'ACTIVE',
    notes,
    received_on,
    certificate_available = false,
    certification_status = 'NOT_CERTIFIED',
    production_allowed = false
  } = req.body;
  
  if (!code || !name || !species || !strain_type) {
    return res.status(400).json({ 
      error: 'Champs obligatoires manquants: code, name, species, strain_type' 
    });
  }
  
  if (!['INTERNAL', 'EXTERNAL'].includes(strain_type)) {
    return res.status(400).json({ 
      error: 'strain_type doit être INTERNAL ou EXTERNAL' 
    });
  }
  
  if (strain_type === 'INTERNAL') {
    if (!created_on) {
      return res.status(400).json({ 
        error: 'created_on obligatoire pour les souches internes' 
      });
    }
    if (certificate_available === true) {
      return res.status(400).json({ 
        error: 'Les souches internes ne peuvent pas avoir de certificat externe' 
      });
    }
  }
  
  if (production_allowed === true && certification_status !== 'CERTIFIED') {
    return res.status(400).json({ 
      error: 'production_allowed nécessite certification_status = CERTIFIED' 
    });
  }
  
  try {
    const result = await req.db.query(
      `INSERT INTO strains (
        code, name, species, strain_type, form,
        source_name, source_ref, quantity, unit,
        created_on, manufactured_on, expiry_on,
        storage_temp_c, storage_location, status,
        notes, received_on,
        certificate_available, certification_status, production_allowed
      ) VALUES (
        $1, $2, $3, $4::strain_type_enum, $5::strain_form_enum,
        $6, $7, $8, $9::quantity_unit_enum,
        $10, $11, $12,
        $13, $14, $15::strain_status_enum,
        $16, $17,
        $18, $19::strain_certification_status_enum, $20
      )
      RETURNING *`,
      [
        code, name, species, strain_type, form,
        source_name, source_ref, quantity, unit,
        created_on, manufactured_on, expiry_on,
        storage_temp_c, storage_location, status,
        notes, received_on,
        certificate_available, certification_status, production_allowed
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/strains:', error);
    
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ce code de souche existe déjà' });
    }
    
    res.status(500).json({ error: 'Erreur lors de la création de la souche' });
  }
});

router.put('/strains/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    species,
    quantity,
    unit,
    storage_temp_c,
    storage_location,
    status,
    notes,
    certification_status,
    production_allowed
  } = req.body;
  
  try {
    const existingStrain = await req.db.query(
      'SELECT * FROM strains WHERE id = $1::UUID',
      [id]
    );
    
    if (existingStrain.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    if (production_allowed === true && certification_status !== 'CERTIFIED') {
      return res.status(400).json({ 
        error: 'production_allowed nécessite certification_status = CERTIFIED' 
      });
    }
    
    const result = await req.db.query(
      `UPDATE strains SET
        name = COALESCE($1, name),
        species = COALESCE($2, species),
        quantity = COALESCE($3, quantity),
        unit = COALESCE($4::quantity_unit_enum, unit),
        storage_temp_c = COALESCE($5, storage_temp_c),
        storage_location = COALESCE($6, storage_location),
        status = COALESCE($7::strain_status_enum, status),
        notes = COALESCE($8, notes),
        certification_status = COALESCE($9::strain_certification_status_enum, certification_status),
        production_allowed = COALESCE($10, production_allowed),
        updated_at = NOW()
      WHERE id = $11::UUID
      RETURNING *`,
      [
        name, species, quantity, unit,
        storage_temp_c, storage_location, status, notes,
        certification_status, production_allowed,
        id
      ]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/strains/:id:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la souche' });
  }
});

router.delete('/strains/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      `UPDATE strains SET 
        status = 'ARCHIVED'::strain_status_enum,
        updated_at = NOW()
      WHERE id = $1::UUID
      RETURNING *`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    res.json({ message: 'Souche archivée avec succès', strain: result.rows[0] });
  } catch (error) {
    console.error('Erreur DELETE /api/strains/:id:', error);
    res.status(500).json({ error: 'Erreur lors de l\'archivage de la souche' });
  }
});

// ============================================================
// ROUTES P3 VALIDÉS - VERSION FINALE CORRIGÉE
// ============================================================

/**
 * GET /api/petris/p3-valides
 * STRUCTURE RÉELLE VÉRIFIÉE:
 * - iso_geloses n'a PAS de gelose_id
 * - iso_geloses.nom contient le nom de la gélose
 * - Pas de lien avec types_gelose
 */
router.get('/petris/p3-valides', async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT 
        p.id,
        p.isolement_id,
        p.phase,
        p.j0,
        p.status,
        i.code AS isolement_code,
        i.champignon AS espece,
        i.categorie,
        i.origine,
        ig.nom AS gelose_nom
      FROM iso_petris p
      LEFT JOIN isolements i ON p.isolement_id = i.id
      LEFT JOIN iso_geloses ig ON p.gelose_id = ig.id
      WHERE p.phase = 3
        AND p.status = 'VALIDE'
        AND NOT EXISTS (
          SELECT 1 FROM strains s 
          WHERE s.source_ref = CAST(p.id AS VARCHAR)
        )
      ORDER BY p.j0 DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Erreur P3 validés:', err);
    res.status(500).json({ error: err.message });
  }
});


router.post('/petris/:id/use-for-strain', async (req, res) => {
  const { id } = req.params;
  
  try {
    const petriCheck = await req.db.query(
      'SELECT * FROM iso_petris WHERE id = $1',
      [id]
    );
    
    if (petriCheck.rows.length === 0) {
      return res.status(404).json({ error: 'P3 non trouvé' });
    }
    
    const petri = petriCheck.rows[0];
    
    if (petri.phase !== 3) {
      return res.status(400).json({ error: 'Ce petri n\'est pas en phase P3' });
    }
    
    if (petri.status !== 'VALIDE') {
      return res.status(400).json({ 
        error: `Ce P3 a un statut ${petri.status} et ne peut pas être utilisé` 
      });
    }
    
    await req.db.query(
      `UPDATE iso_petris SET 
        status = 'TERMINE',
        updated_at = NOW()
      WHERE id = $1`,
      [id]
    );
    
    res.json({ message: 'P3 marqué comme utilisé pour création de souche' });
  } catch (error) {
    console.error('Erreur POST /api/petris/:id/use-for-strain:', error);
    res.status(500).json({ error: 'Erreur lors du marquage du P3' });
  }
});

// ============================================================
// ROUTES JOURNAL DES SOUCHES
// ============================================================

router.get('/strains/by-source/:petri_id', async (req, res) => {
  const { petri_id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT * FROM strains WHERE source_ref = $1`,
      [petri_id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée pour ce P3' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/strains/by-source:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la souche' });
  }
});

router.get('/strains/:id/manipulations', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT * FROM strain_manipulations 
       WHERE strain_id = $1::UUID
       ORDER BY created_at DESC`,
      [id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/strains/:id/manipulations:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des manipulations' });
  }
});

router.post('/strains/:id/manipulations', async (req, res) => {
  const { id } = req.params;
  const {
    manipulation_type,
    notes,
    temperature_c,
    created_by = 'admin'
  } = req.body;
  
  if (!manipulation_type || !notes) {
    return res.status(400).json({ 
      error: 'Champs obligatoires manquants: manipulation_type, notes' 
    });
  }
  
  const validTypes = ['TRANSFERT', 'VERIFICATION', 'PRELEVEMENT', 'CONTAMINATION', 'STOCKAGE', 'AUTRE'];
  if (!validTypes.includes(manipulation_type)) {
    return res.status(400).json({ 
      error: `manipulation_type doit être l'un de: ${validTypes.join(', ')}` 
    });
  }
  
  if (temperature_c !== null && temperature_c !== undefined) {
    if (temperature_c < 0 || temperature_c > 10) {
      return res.status(400).json({ 
        error: 'Température doit être entre 0 et 10°C' 
      });
    }
  }
  
  try {
    const strainCheck = await req.db.query(
      'SELECT id FROM strains WHERE id = $1::UUID',
      [id]
    );
    
    if (strainCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    const result = await req.db.query(
      `INSERT INTO strain_manipulations (
        strain_id, manipulation_type, notes, temperature_c, created_by
      ) VALUES ($1::UUID, $2, $3, $4, $5)
      RETURNING *`,
      [id, manipulation_type, notes, temperature_c, created_by]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/strains/:id/manipulations:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la manipulation' });
  }
});

router.get('/strains/:id/stats', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      'SELECT * FROM get_strain_manipulation_stats($1::UUID)',
      [id]
    );
    
    res.json(result.rows[0] || {
      total_manipulations: 0,
      last_manipulation_date: null,
      last_verification_date: null,
      average_temperature: null
    });
  } catch (error) {
    console.error('Erreur GET /api/strains/:id/stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

router.delete('/strains/:id/manipulations/:manip_id', async (req, res) => {
  const { id, manip_id } = req.params;
  
  try {
    const result = await req.db.query(
      `DELETE FROM strain_manipulations 
       WHERE id = $1 AND strain_id = $2::UUID
       RETURNING *`,
      [manip_id, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Manipulation non trouvée' });
    }
    
    res.json({ 
      message: 'Manipulation supprimée avec succès',
      manipulation: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur DELETE manipulation:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la manipulation' });
  }
});

router.get('/strains/:id/expiry-alert', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT 
        id,
        code,
        name,
        created_on,
        created_on + INTERVAL '2 years' AS expiry_date,
        EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) AS days_until_expiry,
        CASE 
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 0 THEN 'EXPIRED'
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 30 THEN 'CRITICAL'
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 90 THEN 'WARNING'
          ELSE 'OK'
        END AS alert_level
      FROM strains
      WHERE id = $1::UUID AND strain_type = 'INTERNAL'::strain_type_enum`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche interne non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET expiry alert:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification d\'expiration' });
  }
});

// ============================================================
// IMPRESSION ÉTIQUETTES
// ============================================================

router.post('/labels/print', async (req, res) => {
  const { code, type = 'STRAIN', quantity = 1 } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Code obligatoire' });
  }
  
  try {
    if (type === 'STRAIN') {
      const strainResult = await req.db.query(
        'SELECT * FROM strains WHERE code = $1',
        [code]
      );
      
      if (strainResult.rows.length === 0) {
        return res.status(404).json({ error: 'Souche non trouvée' });
      }
      
      const strain = strainResult.rows[0];
      
      console.log('=== IMPRESSION ÉTIQUETTE ===');
      console.log('Code:', code);
      console.log('Nom:', strain.name);
      console.log('Espèce:', strain.species);
      console.log('Type:', strain.strain_type);
      console.log('Date:', new Date().toLocaleDateString('fr-FR'));
      console.log('Quantité:', quantity);
      console.log('===========================');
      
      await req.db.query(
        `INSERT INTO print_logs (
          item_code, item_type, quantity, printed_at
        ) VALUES ($1, $2, $3, NOW())`,
        [code, type, quantity]
      ).catch(() => {});
    }
    
    res.json({ 
      message: `Demande d'impression envoyée: ${quantity} étiquette(s) pour ${code}`,
      success: true 
    });
  } catch (error) {
    console.error('Erreur POST /api/labels/print:', error);
    res.status(500).json({ error: 'Erreur lors de l\'impression' });
  }
});

module.exports = router;