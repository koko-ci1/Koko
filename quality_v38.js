/*
 * KÔKÔ V3.8 — Contrôle qualité & alertes
 * Standalone integration helper. Signals only; no automatic technical verdicts.
 */
module.exports = function registerQualityRoutes(app, db, auth) {
  if (!app || !db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      intervention_id INTEGER,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'AMBER',
      title TEXT NOT NULL,
      explanation TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      acknowledged_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS quality_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const requireAuth = auth || ((req,res,next)=>next());

  app.get('/api/quality/alerts', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM quality_alerts ORDER BY created_at DESC').all();
    res.json(rows);
  });

  app.get('/api/admin/quality/alerts', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM quality_alerts ORDER BY CASE severity WHEN "RED" THEN 1 WHEN "AMBER" THEN 2 ELSE 3 END, created_at DESC').all();
    res.json(rows);
  });

  app.get('/api/quality/dashboard', requireAuth, (req,res)=>{
    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN status='OPEN' AND severity='RED' THEN 1 ELSE 0 END) red_open,
        SUM(CASE WHEN status='OPEN' AND severity='AMBER' THEN 1 ELSE 0 END) amber_open,
        SUM(CASE WHEN status='OPEN' AND severity='GREEN' THEN 1 ELSE 0 END) green_open,
        COUNT(*) total
      FROM quality_alerts
    `).get();
    res.json(summary);
  });

  app.get('/api/quality/interventions/:id', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM quality_alerts WHERE intervention_id=? ORDER BY created_at DESC').all(req.params.id);
    res.json(rows);
  });

  app.post('/api/quality/scan', requireAuth, (req,res)=>{
    // The host application may add project-specific rule checks here.
    // This prototype records the scan without pretending to assess workmanship.
    const scope = req.body?.scope || 'GLOBAL';
    const r = db.prepare('INSERT INTO quality_scans (scope,result_count) VALUES (?,0)').run(scope);
    res.json({scan_id:r.lastInsertRowid, scope, result_count:0, note:'Moteur de règles métier à calibrer avec les données réelles.'});
  });

  app.post('/api/quality/alerts/:id/acknowledge', requireAuth, (req,res)=>{
    const r = db.prepare('UPDATE quality_alerts SET status="ACKNOWLEDGED", acknowledged_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
    if (!r.changes) return res.status(404).json({error:'Alerte introuvable'});
    res.json({id:Number(req.params.id),status:'ACKNOWLEDGED'});
  });

  app.post('/api/quality/alerts/:id/resolve', requireAuth, (req,res)=>{
    const r = db.prepare('UPDATE quality_alerts SET status="RESOLVED", resolved_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
    if (!r.changes) return res.status(404).json({error:'Alerte introuvable'});
    res.json({id:Number(req.params.id),status:'RESOLVED'});
  });
};
