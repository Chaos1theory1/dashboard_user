/**
 * Routes API pour la gestion des LC (Mycélium Liquide)
 * Backend Node.js/Express pour BaslyAgro.Biotech
 * VERSION FINALE - 01/02/2026
 */

const express = require('express');
const router = express.Router();

// ==========================
// Helpers (source_ref / petri / isolement)
// ==========================
function extractPetriId(sourceRef) {
  if (sourceRef === null || sourceRef === undefined) return null;
  const raw = String(sourceRef).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return parseInt(raw, 10);

  const m = raw.match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

async function resolveIsolementFromSourceRef(db, sourceRef) {
  const petriId = extractPetriId(sourceRef);
  if (!Number.isFinite(petriId) || petriId <= 0) {
    return { petriId: null, petri: null, reason: 'SOURCE_REF_INVALID' };
  }

  const result = await db.query(`
    WITH RECURSIVE petri_chain AS (
      SELECT p.id, p.parent_id, p.phase, p.isolement_id
      FROM iso_petris p
      WHERE p.id = $1

      UNION ALL

      SELECT parent.id, parent.parent_id, parent.phase, parent.isolement_id
      FROM iso_petris parent
      JOIN petri_chain child ON child.parent_id = parent.id
    )
    SELECT
      start_p.id AS source_petri_id,
      start_p.phase AS source_phase,
      COALESCE(
        (SELECT pc.isolement_id FROM petri_chain pc WHERE pc.isolement_id IS NOT NULL ORDER BY pc.id LIMIT 1),
        start_p.isolement_id
      ) AS isolement_id,
      root_p.id AS root_petri_id,
      root_p.phase AS root_phase
    FROM iso_petris start_p
    LEFT JOIN LATERAL (
      SELECT pc.id, pc.phase
      FROM petri_chain pc
      WHERE pc.parent_id IS NULL
      ORDER BY pc.id
      LIMIT 1
    ) root_p ON true
    WHERE start_p.id = $1
    LIMIT 1
  `, [petriId]);

  if (result.rows.length === 0) {
    return { petriId, petri: null, reason: 'PETRI_NOT_FOUND' };
  }

  return { petriId, petri: result.rows[0], reason: null };
}

  // ==========================
  // Helpers (LC)
  // ==========================
  function guessLCTemplate(champignon = '', cycleType = '') {
    const c = String(champignon || '').toLowerCase();
    const t = String(cycleType || '').toLowerCase();

    // Priorité au cycle_type si fourni
    if (t.includes('pleuro')) return 'PLEUROTE';
    if (t.includes('agaricus')) return 'AGARICUS';

    if (c.includes('pleurot')) return 'PLEUROTE';
    if (c.includes('pleurotus')) return 'PLEUROTE';
    if (c.includes('agaric')) return 'AGARICUS';
    if (c.includes('agaricus')) return 'AGARICUS';

    return 'GENERIC';
  }

  function normalizeSolutions(solutionLc) {
    if (!solutionLc) return [];
    return Array.isArray(solutionLc) ? solutionLc : [solutionLc];
  }

  async function generateLcCode(db) {
    const today = new Date();
    const year = today.getFullYear();
    const lcRes = await db.query(
      'SELECT COUNT(*) FROM lc_lots WHERE EXTRACT(YEAR FROM created_at) = $1',
      [year]
    );
    const num = parseInt(lcRes.rows?.[0]?.count || '0', 10) + 1;
    return `LC-${year}-${String(num).padStart(3, '0')}`;
  }

  async function ensureLcPots(db, lcLotId, totalPots) {
    // Créer les enregistrements de pots si inexistants
    // (certaines bases peuvent avoir un trigger; on évite les doublons)
    try {
      const countRes = await db.query(
        'SELECT COUNT(*)::int AS c FROM lc_pots WHERE lc_lot_id = $1',
        [lcLotId]
      );
      const existing = countRes.rows?.[0]?.c || 0;
      if (existing > 0) return;

      const valuesSql = Array.from({ length: totalPots }, (_, i) => `($1, ${i + 1}, 'ACTIF')`).join(', ');
      await db.query(
        `INSERT INTO lc_pots (lc_lot_id, pot_number, status) VALUES ${valuesSql}`,
        [lcLotId]
      );
    } catch (e) {
      // Si la table n'existe pas encore, ou autre souci DB, on ne bloque pas la création du lot.
      console.warn('ensureLcPots: impossible de créer les pots (table manquante ou autre)', e.message);
    }
  }


// ============================================================
// GESTION DES LOTS LC
// ============================================================

/**
 * POST /api/lc/create-from-p3
 * Créer un lot LC depuis un P3 validé
 */
/**
 * POST /api/lc/create-from-p3
 * Création d'un lot LC depuis un P3 validé
 */
/**
 * POST /api/lc/create-from-p3
 * Création d'un lot LC depuis un P3 validé
 */
router.post('/lc/create-from-p3', async (req, res) => {
  const { petri_id, solution_id, total_pots = 6, volume_par_pot_ml, volume_par_pot } = req.body;
  const petriId = parseInt(String(petri_id), 10);
  const totalPots = parseInt(String(total_pots), 10);
  const volumeParPotMl = parseInt(String(volume_par_pot_ml ?? volume_par_pot ?? 700), 10);

  if (!petriId) return res.status(400).json({ error: 'petri_id requis' });
  if (!Number.isFinite(totalPots) || totalPots <= 0) return res.status(400).json({ error: 'total_pots invalide' });
  if (!Number.isFinite(volumeParPotMl) || volumeParPotMl <= 0) return res.status(400).json({ error: 'volume_par_pot_ml invalide' });

  const usedMl = totalPots * volumeParPotMl;

  const client = await req.db.connect();
  try {
    await client.query('BEGIN');

    const petriRes = await client.query(`
      SELECT p.*, i.code as iso_code, i.champignon, i.cycle_type
      FROM iso_petris p
      JOIN isolements i ON p.isolement_id = i.id
      WHERE p.id = $1 AND p.phase = 3 AND p.status = 'VALIDE'
    `, [petriId]);

    if (petriRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'P3 validé non trouvé' });
    }

    const petri = petriRes.rows[0];

    // pick solution: explicit or latest for isolement
    let solId = solution_id ? parseInt(String(solution_id), 10) : null;
    if (!solId) {
      const latest = await client.query(`
        SELECT id
        FROM solution_nutritive
        WHERE isolation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [petri.isolement_id]);
      solId = latest.rows?.[0]?.id || null;
    }

    let solutionJson = { note: 'Aucune solution_nutritive liée (stock non géré).' };
    let stock = null;

    if (solId) {
      const solRes = await client.query(`
        SELECT id, nom, volume_final_ml, isolation_id
        FROM solution_nutritive
        WHERE id = $1
        FOR UPDATE
      `, [solId]);

      if (solRes.rows.length > 0 && String(solRes.rows[0].isolation_id) === String(petri.isolement_id)) {
        const sol = solRes.rows[0];
        const beforeMl = parseInt(String(sol.volume_final_ml ?? 0), 10);

        if (!Number.isFinite(beforeMl) || beforeMl < usedMl) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Stock insuffisant. Disponible ${beforeMl} ml, demandé ${usedMl} ml.` });
        }

        const afterMl = beforeMl - usedMl;

        await client.query(`UPDATE solution_nutritive SET volume_final_ml = $2 WHERE id = $1`, [sol.id, afterMl]);

        solutionJson = {
          solution_id: sol.id,
          nom: sol.nom,
          stock_avant_ml: beforeMl,
          utilise_ml: usedMl,
          stock_apres_ml: afterMl
        };
        stock = { before_ml: beforeMl, used_ml: usedMl, after_ml: afterMl, solution_id: sol.id };
      }
    }

    const code = await generateLcCode(client);

    const lcResult = await client.query(`
      INSERT INTO lc_lots (
        code, parent_iso_id, parent_iso_code, champignon,
        categorie, origine, solution,
        total_pots, volume_par_pot_ml, j0_date,
        source_type, source_strain_id,
        cycle_status, certification_status
      )
      VALUES ($1, $2, $3, $4,
              'LC1', 'Interne', $5,
              $6, $7, CURRENT_DATE,
              'P3', NULL,
              'EN_COURS', 'NON_CERTIFIE')
      RETURNING *
    `, [
      code,
      petri.isolement_id,
      petri.iso_code,
      petri.champignon || '—',
      solutionJson,
      totalPots,
      volumeParPotMl
    ]);

    const lcLot = lcResult.rows[0];

    await ensureLcPots(client, lcLot.id, totalPots);

    await client.query(`
      INSERT INTO lc_manipulations (lc_lot_id, jour, date_manipulation, type_manipulation, observation, contamination)
      VALUES ($1, 0, CURRENT_DATE, 'CREATION', $2, false)
    `, [lcLot.id, `Création du lot LC depuis P3-${petriId}`]);

    await client.query('COMMIT');

    return res.json({
      message: 'Lot LC créé avec succès',
      lc_lot: lcLot,
      stock
    });

  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Erreur création LC:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


/**
 * GET /api/lc/strains/:id/solutions
 * Retourne la/les solutions nutritives proposées pour créer un LC depuis une souche
 */
router.get('/lc/strains/:id/solutions', async (req, res) => {
  const { id } = req.params;

  try {
    const sRes = await req.db.query(`
      SELECT id, code, species, strain_type, source_ref
      FROM strains
      WHERE id = $1
    `, [id]);

    if (sRes.rows.length === 0) return res.status(404).json({ error: 'Souche non trouvée' });

    const strain = sRes.rows[0];

    if ((strain.strain_type || '').toUpperCase() !== 'INTERNAL' || !strain.source_ref) {
      return res.json({ supported: false, strain_id: strain.id, solutions: [], reason: 'UNSUPPORTED_STRAIN' });
    }

    const resolved = await resolveIsolementFromSourceRef(req.db, strain.source_ref);
    if (!resolved.petriId) {
      return res.json({ supported: false, strain_id: strain.id, solutions: [], reason: 'SOURCE_REF_INVALID' });
    }

    if (!resolved.petri) {
      return res.json({ supported: true, strain_id: strain.id, source_petri_id: resolved.petriId, isolement_id: null, solutions: [], reason: 'PETRI_NOT_FOUND' });
    }

    const isolement_id = resolved.petri.isolement_id;
    if (!isolement_id) {
      return res.json({ supported: true, strain_id: strain.id, source_petri_id: resolved.petriId, isolement_id: null, solutions: [], reason: 'ISOLEMENT_NOT_FOUND' });
    }

    const solRes = await req.db.query(`
      SELECT id, nom, volume_final_ml, notes, created_at
      FROM solution_nutritive
      WHERE isolation_id = $1
      ORDER BY created_at DESC, id DESC
    `, [isolement_id]);

    return res.json({
      supported: true,
      strain_id: strain.id,
      source_petri_id: resolved.petri.source_petri_id,
      source_phase: resolved.petri.source_phase,
      root_petri_id: resolved.petri.root_petri_id,
      root_phase: resolved.petri.root_phase,
      isolement_id,
      solutions: solRes.rows || [],
      auto_selected: (solRes.rows || []).length === 1
    });
  } catch (error) {
    console.error('Erreur GET /api/lc/strains/:id/solutions:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/lc/create-from-strain
 * Création d'un lot LC depuis une souche (interne ou externe)
 */
router.post('/lc/create-from-strain', async (req, res) => {
  const { strain_id, solution_id, total_pots = 6, volume_par_pot_ml, volume_par_pot } = req.body;
  const totalPots = parseInt(String(total_pots), 10);
  const volumeParPotMl = parseInt(String(volume_par_pot_ml ?? volume_par_pot ?? 700), 10);
  const solId = parseInt(String(solution_id), 10);

  if (!strain_id) return res.status(400).json({ error: 'strain_id requis' });
  if (!Number.isFinite(solId) || solId <= 0) return res.status(400).json({ error: 'solution_id requis' });
  if (!Number.isFinite(totalPots) || totalPots <= 0) return res.status(400).json({ error: 'total_pots invalide' });
  if (!Number.isFinite(volumeParPotMl) || volumeParPotMl <= 0) return res.status(400).json({ error: 'volume_par_pot_ml invalide' });

  const usedMl = totalPots * volumeParPotMl;

  const client = await req.db.connect();
  try {
    await client.query('BEGIN');

    const sRes = await client.query(`
      SELECT id, code, species, strain_type, source_ref
      FROM strains
      WHERE id = $1
    `, [strain_id]);

    if (sRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    const strain = sRes.rows[0];

    if ((strain.strain_type || '').toUpperCase() !== 'INTERNAL' || !strain.source_ref) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Création LC autorisée uniquement pour les souches INTERNES liées à une petri source." });
    }

    const resolved = await resolveIsolementFromSourceRef(client, strain.source_ref);
    if (!resolved.petriId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "source_ref invalide (ex: 12, P1-12, P2-12, P3-12)" });
    }

    if (!resolved.petri || !resolved.petri.isolement_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Impossible de retrouver l'isolement depuis la petri source." });
    }

    const pRes = await client.query(`
      SELECT i.id AS isolement_id, i.code as iso_code, i.champignon, i.cycle_type
      FROM isolements i
      WHERE i.id = $1
    `, [resolved.petri.isolement_id]);

    if (pRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Isolement source introuvable." });
    }

    const parentIsoId = pRes.rows[0].isolement_id;
    const parentIsoCode = pRes.rows[0].iso_code;
    const champignon = pRes.rows[0].champignon || strain.species || '—';

    // Lock solution row + validate it belongs to isolement
    const solRes = await client.query(`
      SELECT id, nom, volume_final_ml, isolation_id
      FROM solution_nutritive
      WHERE id = $1
      FOR UPDATE
    `, [solId]);

    if (solRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Solution nutritive introuvable' });
    }
    const sol = solRes.rows[0];

    if (String(sol.isolation_id) !== String(parentIsoId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Cette solution n'appartient pas à l'isolement de cette souche." });
    }

    const beforeMl = parseInt(String(sol.volume_final_ml ?? 0), 10);
    if (!Number.isFinite(beforeMl) || beforeMl <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Stock solution invalide (volume_final_ml)." });
    }
    if (beforeMl < usedMl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Stock insuffisant. Disponible ${beforeMl} ml, demandé ${usedMl} ml.` });
    }

    const afterMl = beforeMl - usedMl;

    await client.query(`
      UPDATE solution_nutritive
      SET volume_final_ml = $2
      WHERE id = $1
    `, [sol.id, afterMl]);

    const code = await generateLcCode(client);

    const solutionJson = {
      solution_id: sol.id,
      nom: sol.nom,
      stock_avant_ml: beforeMl,
      utilise_ml: usedMl,
      stock_apres_ml: afterMl
    };

    const lcResult = await client.query(`
      INSERT INTO lc_lots (
        code, parent_iso_id, parent_iso_code, champignon,
        categorie, origine, solution,
        total_pots, volume_par_pot_ml, j0_date,
        source_type, source_strain_id,
        cycle_status, certification_status
      )
      VALUES ($1, $2, $3, $4,
              'LC1', 'Interne', $5,
              $6, $7, CURRENT_DATE,
              'STRAIN', $8,
              'EN_COURS', 'NON_CERTIFIE')
      RETURNING *
    `, [
      code,
      parentIsoId,
      parentIsoCode,
      champignon,
      solutionJson,
      totalPots,
      volumeParPotMl,
      strain.id
    ]);

    const lcLot = lcResult.rows[0];

    await ensureLcPots(client, lcLot.id, totalPots);

    await client.query(`
      INSERT INTO lc_manipulations (lc_lot_id, jour, date_manipulation, type_manipulation, observation, contamination)
      VALUES ($1, 0, CURRENT_DATE, 'CREATION', $2, false)
    `, [lcLot.id, `Création du lot LC depuis souche ${strain.code}`]);

    await client.query('COMMIT');

    return res.json({
      message: 'Lot LC créé avec succès',
      lc_lot: lcLot,
      stock: { before_ml: beforeMl, used_ml: usedMl, after_ml: afterMl, solution_id: sol.id }
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Erreur création LC depuis souche:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


/**
 * GET /api/lc/en-cours
 * Liste des LC en cours de cycle
 */
router.get('/lc/en-cours', async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT * FROM v_lc_en_cours
      ORDER BY j0_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/lc/en-cours:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/lc/:id
 * Détails d'un lot LC
 */
router.get('/lc/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await req.db.query(`
      SELECT 
        lc.*,
        (CURRENT_DATE - lc.j0_date) AS jour_actuel,
        COUNT(lcp.id) AS total_pots_crees,
        COUNT(lcp.id) FILTER (WHERE lcp.status = 'ACTIF') AS pots_disponibles,
        COUNT(lcp.id) FILTER (WHERE lcp.status = 'UTILISE') AS pots_utilises
      FROM lc_lots lc
      LEFT JOIN lc_pots lcp ON lcp.lc_lot_id = lc.id
      WHERE lc.id = $1
      GROUP BY lc.id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lot LC non trouvé' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/lc/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/lc/:id/pots
 * Liste des pots d'un lot LC
 */
router.get('/lc/:id/pots', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await req.db.query(`
      SELECT * FROM lc_pots
      WHERE lc_lot_id = $1
      ORDER BY pot_number
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/lc/:id/pots:', error);
    res.status(500).json({ error: error.message });
  }
});


/**
 * GET /api/lc/:id/daily-checks
 * Récupérer les fiches de contrôle journalières (cycle pré-défini)
 */

/**
 * POST /api/lc/:id/daily-checks
 * Enregistrer / mettre à jour la fiche du jour (score + contrôles)
 */


/**
 * GET /api/lc/:id/daily-checks
 * Récupérer les fiches de contrôle journalières (cycle pré-défini)
 */
router.get('/lc/:id/daily-checks', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await req.db.query(`
      SELECT * FROM lc_daily_checks
      WHERE lc_lot_id = $1
      ORDER BY day_number ASC
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/lc/:id/daily-checks:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/lc/:id/daily-checks
 * Enregistrer / mettre à jour la fiche du jour (score + contrôles)
 */
router.post('/lc/:id/daily-checks', async (req, res) => {
  const { id } = req.params;
  const { day_number, checks, score, notes } = req.body;

  if (day_number === undefined || day_number === null) {
    return res.status(400).json({ error: 'day_number requis' });
  }

  try {
    const result = await req.db.query(`
      INSERT INTO lc_daily_checks (lc_lot_id, day_number, checks, score, notes, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (lc_lot_id, day_number)
      DO UPDATE SET
        checks = EXCLUDED.checks,
        score = EXCLUDED.score,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING *
    `, [
      id,
      parseInt(day_number, 10),
      (checks || {}),
      parseInt(score || 0, 10),
      notes || null
    ])

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/lc/:id/daily-checks:', error);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================
// MANIPULATIONS QUOTIDIENNES LC
// ============================================================

/**
 * GET /api/lc/:id/manipulations
 * Journal des manipulations d'un lot LC
 */
router.get('/lc/:id/manipulations', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await req.db.query(`
      SELECT * FROM lc_manipulations
      WHERE lc_lot_id = $1
      ORDER BY jour ASC
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/lc/:id/manipulations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/lc/:id/manipulations
 * Ajouter une manipulation quotidienne
 */
router.post('/lc/:id/manipulations', async (req, res) => {
  const { id } = req.params;
  const {
    jour,
    type_manipulation,
    frequence_agitation = 0,
    observation,
    temperature_c,
    contamination = false,
    photo_url,
    operateur = 'admin'
  } = req.body;

  if (jour === undefined || !type_manipulation) {
    return res.status(400).json({ 
      error: 'jour et type_manipulation obligatoires' 
    });
  }

  try {
    const result = await req.db.query(`
      INSERT INTO lc_manipulations (
        lc_lot_id, jour, date_manipulation, type_manipulation,
        frequence_agitation, observation, temperature_c, contamination,
        photo_url, operateur
      )
      VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      id, jour, type_manipulation, frequence_agitation,
      observation, temperature_c, contamination, photo_url, operateur
    ]);

    // Si contamination détectée, mettre à jour le statut du lot
    if (contamination) {
      await req.db.query(`
        UPDATE lc_lots 
        SET cycle_status = 'REJETE', certification_status = 'REJETE'
        WHERE id = $1
      `, [id]);
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/lc/:id/manipulations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/lc/:id/terminer-cycle
 * Marquer le cycle LC comme terminé (J14)
 */
router.put('/lc/:id/terminer-cycle', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await req.db.query(`
      UPDATE lc_lots
      SET cycle_status = 'TERMINE', j_actuel = 14
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lot LC non trouvé' });
    }

    res.json({
      success: true,
      message: 'Cycle terminé. Vous pouvez maintenant demander la certification.',
      lc_lot: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur PUT /api/lc/:id/terminer-cycle:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// CERTIFICATIONS LABORATOIRE TUNISIEN
// ============================================================

/**
 * POST /api/certifications/lc
 * Demander certification pour un lot LC
 */
router.post('/certifications/lc', async (req, res) => {
  const {
    lc_lot_id,
    laboratoire,
    reference_certificat,
    date_envoi = new Date().toISOString().split('T')[0],
    observations,
    created_by = 'admin'
  } = req.body;

  if (!lc_lot_id || !laboratoire) {
    return res.status(400).json({ 
      error: 'lc_lot_id et laboratoire obligatoires' 
    });
  }

  try {
    await req.db.query('BEGIN');

    // Créer la demande de certification
    const certResult = await req.db.query(`
      INSERT INTO lc_certifications (
        lc_lot_id, laboratoire, reference_certificat, date_envoi,
        resultat, observations, created_by
      )
      VALUES ($1, $2, $3, $4, 'EN_ATTENTE', $5, $6)
      RETURNING *
    `, [lc_lot_id, laboratoire, reference_certificat, date_envoi, observations, created_by]);

    // Mettre à jour le statut du lot LC
    await req.db.query(`
      UPDATE lc_lots
      SET certification_status = 'EN_ATTENTE'
      WHERE id = $1
    `, [lc_lot_id]);

    await req.db.query('COMMIT');

    res.status(201).json(certResult.rows[0]);
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Erreur POST /api/certifications/lc:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/certifications/strain
 * Demander certification pour une souche externe
 */
router.post('/certifications/strain', async (req, res) => {
  const {
    strain_id,
    laboratoire,
    reference_certificat,
    date_envoi = new Date().toISOString().split('T')[0],
    observations,
    created_by = 'admin'
  } = req.body;

  if (!strain_id || !laboratoire) {
    return res.status(400).json({ 
      error: 'strain_id et laboratoire obligatoires' 
    });
  }

  try {
    await req.db.query('BEGIN');

    const certResult = await req.db.query(`
      INSERT INTO lc_certifications (
        strain_id, laboratoire, reference_certificat, date_envoi,
        resultat, observations, created_by
      )
      VALUES ($1::UUID, $2, $3, $4, 'EN_ATTENTE', $5, $6)
      RETURNING *
    `, [strain_id, laboratoire, reference_certificat, date_envoi, observations, created_by]);

    await req.db.query(`
      UPDATE strains
      SET certification_status = 'PENDING_REVIEW'
      WHERE id = $1::UUID
    `, [strain_id]);

    await req.db.query('COMMIT');

    res.status(201).json(certResult.rows[0]);
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Erreur POST /api/certifications/strain:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/certifications/:id/resultat
 * Enregistrer le résultat de certification
 */
router.put('/certifications/:id/resultat', async (req, res) => {
  const { id } = req.params;
  const {
    resultat,
    date_resultat = new Date().toISOString().split('T')[0],
    contamination_detectee = false,
    croissance_conforme,
    morphologie_conforme,
    observations,
    document_pdf_url
  } = req.body;

  if (!resultat || !['PASS', 'FAIL'].includes(resultat)) {
    return res.status(400).json({ 
      error: 'resultat doit être PASS ou FAIL' 
    });
  }

  try {
    await req.db.query('BEGIN');

    // Mettre à jour la certification
    const certResult = await req.db.query(`
      UPDATE lc_certifications
      SET 
        resultat = $2,
        date_resultat = $3,
        contamination_detectee = $4,
        croissance_conforme = $5,
        morphologie_conforme = $6,
        observations = $7,
        document_pdf_url = $8
      WHERE id = $1
      RETURNING *
    `, [
      id, resultat, date_resultat, contamination_detectee,
      croissance_conforme, morphologie_conforme, observations, document_pdf_url
    ]);

    if (certResult.rows.length === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'Certification non trouvée' });
    }

    const cert = certResult.rows[0];

    // Mettre à jour le lot LC ou la souche selon le résultat
    if (cert.lc_lot_id) {
      await req.db.query(`
        UPDATE lc_lots
        SET 
          certification_status = $2,
          certification_date = $3,
          production_allowed = $4,
          cycle_status = CASE WHEN $2 = 'CERTIFIE' THEN 'CERTIFIE' ELSE cycle_status END
        WHERE id = $1
      `, [
        cert.lc_lot_id,
        resultat === 'PASS' ? 'CERTIFIE' : 'REJETE',
        date_resultat,
        resultat === 'PASS'
      ]);
    }

    if (cert.strain_id) {
      await req.db.query(`
        UPDATE strains
        SET 
          certification_status = $2,
          production_allowed = $3
        WHERE id = $1::UUID
      `, [
        cert.strain_id,
        resultat === 'PASS' ? 'CERTIFIED' : 'REJECTED',
        resultat === 'PASS'
      ]);
    }

    await req.db.query('COMMIT');

    res.json({
      success: true,
      certification: certResult.rows[0],
      message: resultat === 'PASS' 
        ? 'Certification réussie ! Production autorisée.' 
        : 'Certification échouée. Production non autorisée.'
    });
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Erreur PUT /api/certifications/:id/resultat:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/certifications
 * Liste de toutes les certifications
 */
router.get('/certifications', async (req, res) => {
  const { status } = req.query;

  try {
    let query = `
      SELECT 
        c.*,
        CASE 
          WHEN c.lc_lot_id IS NOT NULL THEN (SELECT code FROM lc_lots WHERE id = c.lc_lot_id)
          WHEN c.strain_id IS NOT NULL THEN (SELECT code FROM strains WHERE id = c.strain_id)
        END AS source_code,
        CASE 
          WHEN c.lc_lot_id IS NOT NULL THEN 'LC_INTERNE'
          WHEN c.strain_id IS NOT NULL THEN 'SOUCHE_EXTERNE'
        END AS source_type
      FROM lc_certifications c
    `;

    const params = [];
    if (status) {
      query += ` WHERE c.resultat = $1`;
      params.push(status);
    }

    query += ` ORDER BY c.date_envoi DESC`;

    const result = await req.db.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/certifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PLANNING PRODUCTION
// ============================================================

/**
 * GET /api/planning/current
 * Planning du trimestre actuel par espèce
 */
router.get('/planning/current', async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.floor(now.getMonth() / 3) + 1;

    const result = await req.db.query(`
      SELECT 
        pp.*,
        e.nom_scientifique,
        e.nom_commun
      FROM production_planning pp
      JOIN especes e ON e.id_espece = pp.espece_id
      WHERE pp.annee = $1 AND pp.trimestre = $2
      ORDER BY e.nom_scientifique
    `, [year, quarter]);

    res.json({
      year,
      quarter,
      planning: result.rows
    });
  } catch (error) {
    console.error('Erreur GET /api/planning/current:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/planning/:id
 * Mettre à jour les statistiques du planning
 */
router.put('/planning/:id', async (req, res) => {
  const { id } = req.params;
  const {
    objectif_kg,
    produit_kg,
    p3_disponibles,
    lc_en_cours,
    lc_certifies
  } = req.body;

  try {
    const result = await req.db.query(`
      UPDATE production_planning
      SET 
        objectif_kg = COALESCE($2, objectif_kg),
        produit_kg = COALESCE($3, produit_kg),
        p3_disponibles = COALESCE($4, p3_disponibles),
        lc_en_cours = COALESCE($5, lc_en_cours),
        lc_certifies = COALESCE($6, lc_certifies),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, objectif_kg, produit_kg, p3_disponibles, lc_en_cours, lc_certifies]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Planning non trouvé' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/planning/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;