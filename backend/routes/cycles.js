/**
 * Routes API pour la gestion des cycles de production (90 jours)
 * Backend Node.js/Express pour BaslyAgro.Biotech
 * VERSION 1.0 - 31/01/2026
 */

const express = require('express');
const router = express.Router();

// ============================================================
// GESTION DES CYCLES
// ============================================================

/**
 * GET /api/cycles/current
 * Récupère le cycle actuellement actif
 */
router.get('/cycles/current', async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT * FROM get_active_cycle()
    `);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Aucun cycle actif trouvé',
        message: 'Veuillez créer un nouveau cycle'
      });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/cycles/current:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cycles/:id
 * Détails d'un cycle spécifique
 */
router.get('/cycles/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT 
        pc.*,
        get_cycle_current_day(pc.id) AS current_day
      FROM production_cycles pc
      WHERE pc.id = $1::UUID
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cycle non trouvé' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cycles
 * Créer un nouveau cycle
 */
router.post('/cycles', async (req, res) => {
  const {
    year,
    quarter,
    start_date,
    notes,
    created_by = 'admin'
  } = req.body;
  
  if (!year || !quarter || !start_date) {
    return res.status(400).json({
      error: 'Champs obligatoires manquants: year, quarter, start_date'
    });
  }
  
  if (quarter < 1 || quarter > 4) {
    return res.status(400).json({
      error: 'Le trimestre doit être entre 1 et 4'
    });
  }
  
  try {
    const result = await req.db.query(`
      INSERT INTO production_cycles (year, quarter, start_date, status, notes, created_by)
      VALUES ($1, $2, $3, 'ACTIVE', $4, $5)
      RETURNING *
    `, [year, quarter, start_date, notes, created_by]);
    
    // Créer les objectifs par défaut
    await req.db.query(`
      INSERT INTO production_targets (cycle_id, target_grain_kg, target_lc_batches)
      VALUES ($1, 1000, 20)
    `, [result.rows[0].id]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/cycles:', error);
    
    if (error.code === '23505') {
      return res.status(409).json({
        error: `Un cycle existe déjà pour Q${quarter} ${year}`
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cycles/:id/stats
 * Statistiques en temps réel d'un cycle
 */
router.get('/cycles/:id/stats', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT * FROM get_cycle_stats($1::UUID)
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cycle non trouvé' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id/stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// SOUCHES DU CYCLE (P1/P2/P3)
// ============================================================

/**
 * GET /api/cycles/:id/strains
 * Liste des souches du cycle
 */
router.get('/cycles/:id/strains', async (req, res) => {
  const { id } = req.params;
  const { status } = req.query; // Filtre optionnel
  
  try {
    let query = `
      SELECT 
        cs.*,
        s.code AS strain_code,
        s.name AS strain_name,
        s.species,
        s.form,
        (pc.elimination_date - CURRENT_DATE) AS days_until_elimination
      FROM cycle_strains cs
      JOIN strains s ON s.id = cs.strain_id
      JOIN production_cycles pc ON pc.id = cs.cycle_id
      WHERE cs.cycle_id = $1::UUID
    `;
    
    const params = [id];
    
    if (status) {
      query += ` AND cs.status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY cs.phase, cs.repiquage_date`;
    
    const result = await req.db.query(query, params);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id/strains:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cycles/:id/strains
 * Ajouter une souche au cycle (repiquage J0)
 */
router.post('/cycles/:id/strains', async (req, res) => {
  const { id } = req.params;
  const {
    strain_id,
    phase,
    repiquage_date,
    notes
  } = req.body;
  
  if (!strain_id || !phase || !repiquage_date) {
    return res.status(400).json({
      error: 'Champs obligatoires: strain_id, phase, repiquage_date'
    });
  }
  
  if (!['P1', 'P2', 'P3', 'P3_SAVE'].includes(phase)) {
    return res.status(400).json({
      error: 'Phase doit être: P1, P2, P3 ou P3_SAVE'
    });
  }
  
  try {
    await req.db.query('BEGIN');
    
    // Récupérer la date d'élimination du cycle
    const cycleResult = await req.db.query(`
      SELECT elimination_date FROM production_cycles WHERE id = $1::UUID
    `, [id]);
    
    if (cycleResult.rows.length === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'Cycle non trouvé' });
    }
    
    const elimination_date = cycleResult.rows[0].elimination_date;
    
    // Ajouter la souche au cycle
    const result = await req.db.query(`
      INSERT INTO cycle_strains (
        cycle_id, strain_id, phase, repiquage_date, elimination_date, notes
      )
      VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6)
      RETURNING *
    `, [id, strain_id, phase, repiquage_date, elimination_date, notes]);
    
    await req.db.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Erreur POST /api/cycles/:id/strains:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/cycles/:id/strains/:strain_id/validate
 * Valider une souche (J14)
 */
router.put('/cycles/:id/strains/:strain_id/validate', async (req, res) => {
  const { id, strain_id } = req.params;
  const { validation_date, storage_date } = req.body;
  
  try {
    const result = await req.db.query(`
      UPDATE cycle_strains
      SET 
        validation_date = COALESCE($3, CURRENT_DATE),
        storage_date = COALESCE($4, CURRENT_DATE),
        updated_at = NOW()
      WHERE cycle_id = $1::UUID AND id = $2::UUID
      RETURNING *
    `, [id, strain_id, validation_date, storage_date]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche du cycle non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/cycles/:id/strains/:strain_id/validate:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cycles/:id/strains/:strain_id/use
 * Utiliser une souche pour créer un lot (incrémente usage_count)
 */
router.post('/cycles/:id/strains/:strain_id/use', async (req, res) => {
  const { id, strain_id } = req.params;
  
  try {
    const result = await req.db.query(`
      UPDATE cycle_strains
      SET 
        usage_count = usage_count + 1,
        updated_at = NOW()
      WHERE cycle_id = $1::UUID AND id = $2::UUID
      RETURNING *
    `, [id, strain_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche du cycle non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/cycles/:id/strains/:strain_id/use:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LOTS DE PRODUCTION
// ============================================================

/**
 * GET /api/cycles/:id/batches
 * Liste des lots du cycle
 */
router.get('/cycles/:id/batches', async (req, res) => {
  const { id } = req.params;
  const { status, batch_type } = req.query;
  
  try {
    let query = `
      SELECT 
        pb.*,
        cs.strain_id,
        s.code AS strain_code,
        s.name AS strain_name,
        s.species,
        CASE 
          WHEN pb.batch_type = 'LC1' AND pb.status = 'IN_PROGRESS' THEN
            (CURRENT_DATE - pb.start_date)
          ELSE NULL
        END AS lc_current_day
      FROM production_batches pb
      JOIN cycle_strains cs ON cs.id = pb.cycle_strain_id
      JOIN strains s ON s.id = cs.strain_id
      WHERE pb.cycle_id = $1::UUID
    `;
    
    const params = [id];
    let paramCount = 1;
    
    if (status) {
      paramCount++;
      query += ` AND pb.status = $${paramCount}`;
      params.push(status);
    }
    
    if (batch_type) {
      paramCount++;
      query += ` AND pb.batch_type = $${paramCount}`;
      params.push(batch_type);
    }
    
    query += ` ORDER BY pb.start_date DESC, pb.created_at DESC`;
    
    const result = await req.db.query(query, params);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id/batches:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cycles/:id/batches
 * Créer un lot de production
 */
router.post('/cycles/:id/batches', async (req, res) => {
  const { id } = req.params;
  const {
    cycle_strain_id,
    batch_type,
    planned_quantity,
    unit = 'kg',
    start_date = new Date().toISOString().split('T')[0],
    notes,
    created_by = 'admin'
  } = req.body;
  
  if (!cycle_strain_id || !batch_type || !planned_quantity) {
    return res.status(400).json({
      error: 'Champs obligatoires: cycle_strain_id, batch_type, planned_quantity'
    });
  }
  
  if (!['LC1', 'GRAIN', 'SPAWN', 'SUBSTRATE'].includes(batch_type)) {
    return res.status(400).json({
      error: 'batch_type doit être: LC1, GRAIN, SPAWN ou SUBSTRATE'
    });
  }
  
  try {
    await req.db.query('BEGIN');
    
    // Vérifier que le cycle est en période de production (J15-J75)
    const cycleCheck = await req.db.query(`
      SELECT 
        production_start_date,
        production_end_date,
        get_cycle_current_day(id) AS current_day
      FROM production_cycles
      WHERE id = $1::UUID
    `, [id]);
    
    if (cycleCheck.rows.length === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'Cycle non trouvé' });
    }
    
    const cycle = cycleCheck.rows[0];
    const currentDay = cycle.current_day;
    
    if (currentDay < 15 || currentDay > 75) {
      await req.db.query('ROLLBACK');
      return res.status(400).json({
        error: `Production autorisée uniquement entre J15 et J75. Jour actuel: J${currentDay}`
      });
    }
    
    // Générer le code du lot
    const codePrefix = batch_type === 'LC1' ? 'LC' : batch_type;
    const year = new Date().getFullYear();
    
    const codeResult = await req.db.query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(batch_code FROM '[0-9]+$') AS INTEGER)), 0) + 1 AS next_num
      FROM production_batches
      WHERE batch_code LIKE $1
    `, [`${codePrefix}-${year}-%`]);
    
    const nextNum = codeResult.rows[0].next_num;
    const batch_code = `${codePrefix}-${year}-${String(nextNum).padStart(3, '0')}`;
    
    // Créer le lot
    const result = await req.db.query(`
      INSERT INTO production_batches (
        batch_code, cycle_id, cycle_strain_id, batch_type,
        planned_quantity, unit, start_date, status, notes, created_by
      )
      VALUES ($1, $2::UUID, $3::UUID, $4, $5, $6, $7, 'IN_PROGRESS', $8, $9)
      RETURNING *
    `, [batch_code, id, cycle_strain_id, batch_type, planned_quantity, unit, start_date, notes, created_by]);
    
    // Incrémenter le compteur d'utilisation de la souche
    await req.db.query(`
      UPDATE cycle_strains
      SET usage_count = usage_count + 1
      WHERE id = $1::UUID
    `, [cycle_strain_id]);
    
    await req.db.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Erreur POST /api/cycles/:id/batches:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/batches/:id
 * Détails d'un lot
 */
router.get('/batches/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT 
        pb.*,
        cs.strain_id,
        cs.phase,
        s.code AS strain_code,
        s.name AS strain_name,
        s.species,
        pc.cycle_number,
        pc.year,
        pc.quarter,
        CASE 
          WHEN pb.batch_type = 'LC1' AND pb.status = 'IN_PROGRESS' THEN
            (CURRENT_DATE - pb.start_date)
          ELSE NULL
        END AS lc_current_day
      FROM production_batches pb
      JOIN cycle_strains cs ON cs.id = pb.cycle_strain_id
      JOIN strains s ON s.id = cs.strain_id
      JOIN production_cycles pc ON pc.id = pb.cycle_id
      WHERE pb.id = $1::UUID
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lot non trouvé' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/batches/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/batches/:id
 * Mettre à jour un lot
 */
router.put('/batches/:id', async (req, res) => {
  const { id } = req.params;
  const {
    status,
    actual_quantity,
    actual_end_date,
    notes
  } = req.body;
  
  try {
    const updates = [];
    const values = [id];
    let paramCount = 1;
    
    if (status) {
      paramCount++;
      updates.push(`status = $${paramCount}`);
      values.push(status);
    }
    
    if (actual_quantity !== undefined) {
      paramCount++;
      updates.push(`actual_quantity = $${paramCount}`);
      values.push(actual_quantity);
    }
    
    if (actual_end_date) {
      paramCount++;
      updates.push(`actual_end_date = $${paramCount}`);
      values.push(actual_end_date);
    }
    
    if (notes) {
      paramCount++;
      updates.push(`notes = $${paramCount}`);
      values.push(notes);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune mise à jour fournie' });
    }
    
    updates.push('updated_at = NOW()');
    
    const result = await req.db.query(`
      UPDATE production_batches
      SET ${updates.join(', ')}
      WHERE id = $1::UUID
      RETURNING *
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lot non trouvé' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/batches/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// OBJECTIFS ET ALERTES
// ============================================================

/**
 * GET /api/cycles/:id/targets
 * Récupérer les objectifs du cycle
 */
router.get('/cycles/:id/targets', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT * FROM production_targets WHERE cycle_id = $1::UUID
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Objectifs non trouvés' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id/targets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/cycles/:id/targets
 * Mettre à jour les objectifs
 */
router.put('/cycles/:id/targets', async (req, res) => {
  const { id } = req.params;
  const {
    target_grain_kg,
    target_lc_batches,
    target_spawn_units
  } = req.body;
  
  try {
    const result = await req.db.query(`
      UPDATE production_targets
      SET 
        target_grain_kg = COALESCE($2, target_grain_kg),
        target_lc_batches = COALESCE($3, target_lc_batches),
        target_spawn_units = COALESCE($4, target_spawn_units),
        updated_at = NOW()
      WHERE cycle_id = $1::UUID
      RETURNING *
    `, [id, target_grain_kg, target_lc_batches, target_spawn_units]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Objectifs non trouvés' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/cycles/:id/targets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cycles/:id/alerts
 * Récupérer les alertes du cycle
 */
router.get('/cycles/:id/alerts', async (req, res) => {
  const { id } = req.params;
  
  try {
    const cycleResult = await req.db.query(`
      SELECT 
        pc.*,
        get_cycle_current_day(pc.id) AS current_day
      FROM production_cycles pc
      WHERE pc.id = $1::UUID
    `, [id]);
    
    if (cycleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cycle non trouvé' });
    }
    
    const cycle = cycleResult.rows[0];
    const currentDay = cycle.current_day;
    const alerts = [];
    
    // Alerte J76+
    if (currentDay >= 76 && currentDay < 90) {
      alerts.push({
        type: 'WARNING',
        priority: 'HIGH',
        message: `⚠️ Période d'alerte (J${currentDay}/J90) - Préparez le prochain cycle`,
        days_until_elimination: 90 - currentDay
      });
    }
    
    // Alerte J90 proche
    if (currentDay >= 85 && currentDay < 90) {
      alerts.push({
        type: 'CRITICAL',
        priority: 'URGENT',
        message: `🔴 ÉLIMINATION DANS ${90 - currentDay} JOURS - Destruction obligatoire`,
        days_until_elimination: 90 - currentDay
      });
    }
    
    // Alerte J14 validation
    if (currentDay >= 14 && currentDay < 20) {
      const pendingValidation = await req.db.query(`
        SELECT COUNT(*) AS count
        FROM cycle_strains
        WHERE cycle_id = $1::UUID AND validation_date IS NULL
      `, [id]);
      
      if (parseInt(pendingValidation.rows[0].count) > 0) {
        alerts.push({
          type: 'INFO',
          priority: 'MEDIUM',
          message: `📋 ${pendingValidation.rows[0].count} souche(s) à valider (J14 passé)`,
          action: 'validate_strains'
        });
      }
    }
    
    // Lots LC en fenêtre optimale
    const lcOptimal = await req.db.query(`
      SELECT COUNT(*) AS count
      FROM production_batches pb
      WHERE pb.cycle_id = $1::UUID
        AND pb.batch_type = 'LC1'
        AND pb.status = 'IN_PROGRESS'
        AND (CURRENT_DATE - pb.start_date) BETWEEN 8 AND 14
    `, [id]);
    
    if (parseInt(lcOptimal.rows[0].count) > 0) {
      alerts.push({
        type: 'SUCCESS',
        priority: 'MEDIUM',
        message: `🟢 ${lcOptimal.rows[0].count} lot(s) LC en fenêtre optimale (J8-J14)`,
        action: 'view_lc_batches'
      });
    }
    
    res.json(alerts);
  } catch (error) {
    console.error('Erreur GET /api/cycles/:id/alerts:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
