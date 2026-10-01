/*
 * KÔKÔ V3.7 — Garantie & SAV
 * Integration helper. Requires an existing Express app and db in the host application.
 * This module intentionally does not create statutory/legal guarantees.
 */
module.exports = function registerWarrantyRoutes(app, db, auth) {
  if (!app || !db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS warranties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER,
      request_id INTEGER,
      professional_user_id INTEGER,
      client_user_id INTEGER,
      title TEXT NOT NULL,
      coverage TEXT NOT NULL,
      exclusions TEXT,
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS warranty_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warranty_id INTEGER NOT NULL,
      opened_by_user_id INTEGER NOT NULL,
      problem TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      resolution TEXT,
      resolved_at TEXT,
      client_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS warranty_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,
      reference TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS warranty_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warranty_id INTEGER,
      claim_id INTEGER,
      actor_user_id INTEGER,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const requireAuth = auth || ((req,res,next)=>next());

  app.post('/api/warranties', requireAuth, (req,res)=>{
    const {
      contract_id, request_id, professional_user_id, client_user_id,
      title, coverage, exclusions, starts_at, expires_at
    } = req.body || {};
    if (!title || !coverage || !starts_at || !expires_at) {
      return res.status(400).json({error:'title, coverage, starts_at et expires_at sont requis'});
    }
    const r = db.prepare(`
      INSERT INTO warranties
      (contract_id,request_id,professional_user_id,client_user_id,title,coverage,exclusions,starts_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(contract_id||null, request_id||null, professional_user_id||null,
          client_user_id||null, title, coverage, exclusions||null, starts_at, expires_at);
    res.status(201).json({id:r.lastInsertRowid, status:'ACTIVE'});
  });

  app.get('/api/warranties', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM warranties ORDER BY created_at DESC').all();
    res.json(rows);
  });

  app.get('/api/warranties/:id', requireAuth, (req,res)=>{
    const w = db.prepare('SELECT * FROM warranties WHERE id=?').get(req.params.id);
    if (!w) return res.status(404).json({error:'Garantie introuvable'});
    const claims = db.prepare('SELECT * FROM warranty_claims WHERE warranty_id=? ORDER BY created_at DESC').all(w.id);
    res.json({...w, claims});
  });

  app.post('/api/warranties/:id/claims', requireAuth, (req,res)=>{
    const w = db.prepare('SELECT * FROM warranties WHERE id=?').get(req.params.id);
    if (!w) return res.status(404).json({error:'Garantie introuvable'});
    const {problem, description} = req.body || {};
    if (!problem) return res.status(400).json({error:'problem est requis'});
    const openedBy = req.user?.id || req.body.opened_by_user_id;
    if (!openedBy) return res.status(400).json({error:'Identité du demandeur requise'});
    const r = db.prepare(`
      INSERT INTO warranty_claims (warranty_id,opened_by_user_id,problem,description)
      VALUES (?,?,?,?)
    `).run(w.id, openedBy, problem, description||null);
    db.prepare(`
      INSERT INTO warranty_events (warranty_id,claim_id,actor_user_id,event_type,payload)
      VALUES (?,?,?,?,?)
    `).run(w.id, r.lastInsertRowid, openedBy, 'CLAIM_OPENED', JSON.stringify({problem}));
    res.status(201).json({id:r.lastInsertRowid, status:'OPEN'});
  });

  app.get('/api/warranties/:id/claims', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM warranty_claims WHERE warranty_id=? ORDER BY created_at DESC').all(req.params.id);
    res.json(rows);
  });

  app.post('/api/warranty-claims/:id/evidence', requireAuth, (req,res)=>{
    const {evidence_type, reference, comment} = req.body || {};
    if (!evidence_type || !reference) return res.status(400).json({error:'evidence_type et reference sont requis'});
    const claim = db.prepare('SELECT * FROM warranty_claims WHERE id=?').get(req.params.id);
    if (!claim) return res.status(404).json({error:'Réclamation introuvable'});
    const r = db.prepare(`
      INSERT INTO warranty_evidence (claim_id,evidence_type,reference,comment)
      VALUES (?,?,?,?)
    `).run(claim.id,evidence_type,reference,comment||null);
    res.status(201).json({id:r.lastInsertRowid});
  });

  app.post('/api/warranty-claims/:id/status', requireAuth, (req,res)=>{
    const {status, note} = req.body || {};
    const allowed = ['OPEN','UNDER_REVIEW','ACCEPTED','REJECTED','SCHEDULED','IN_PROGRESS','RESOLVED','CLIENT_CONFIRMED','CLOSED'];
    if (!allowed.includes(status)) return res.status(400).json({error:'Statut SAV invalide'});
    const claim = db.prepare('SELECT * FROM warranty_claims WHERE id=?').get(req.params.id);
    if (!claim) return res.status(404).json({error:'Réclamation introuvable'});
    db.prepare('UPDATE warranty_claims SET status=?, resolution=COALESCE(?,resolution), resolved_at=CASE WHEN ? IN ("RESOLVED","CLIENT_CONFIRMED","CLOSED") THEN CURRENT_TIMESTAMP ELSE resolved_at END WHERE id=?')
      .run(status,note||null,status,claim.id);
    db.prepare('INSERT INTO warranty_events (warranty_id,claim_id,actor_user_id,event_type,payload) VALUES (?,?,?,?,?)')
      .run(claim.warranty_id,claim.id,req.user?.id||null,'STATUS_CHANGED',JSON.stringify({status,note:note||null}));
    res.json({id:claim.id,status});
  });

  app.post('/api/warranty-claims/:id/resolve', requireAuth, (req,res)=>{
    const {resolution} = req.body || {};
    if (!resolution) return res.status(400).json({error:'resolution est requise'});
    db.prepare('UPDATE warranty_claims SET status="RESOLVED", resolution=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(resolution,req.params.id);
    res.json({id:Number(req.params.id),status:'RESOLVED'});
  });

  app.post('/api/warranty-claims/:id/confirm', requireAuth, (req,res)=>{
    const claim = db.prepare('SELECT * FROM warranty_claims WHERE id=?').get(req.params.id);
    if (!claim) return res.status(404).json({error:'Réclamation introuvable'});
    db.prepare('UPDATE warranty_claims SET status="CLIENT_CONFIRMED", client_confirmed_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.id);
    db.prepare('INSERT INTO warranty_events (warranty_id,claim_id,actor_user_id,event_type,payload) VALUES (?,?,?,?,?)')
      .run(claim.warranty_id,claim.id,req.user?.id||null,'CLIENT_CONFIRMED',null);
    res.json({id:claim.id,status:'CLIENT_CONFIRMED'});
  });

  app.get('/api/warranty-claims/:id/history', requireAuth, (req,res)=>{
    const rows = db.prepare('SELECT * FROM warranty_events WHERE claim_id=? ORDER BY created_at ASC').all(req.params.id);
    res.json(rows);
  });

  app.get('/api/admin/warranty-claims', requireAuth, (req,res)=>{
    const rows = db.prepare(`
      SELECT c.*, w.title AS warranty_title, w.expires_at
      FROM warranty_claims c JOIN warranties w ON w.id=c.warranty_id
      ORDER BY c.created_at DESC
    `).all();
    res.json(rows);
  });
};
