/**
 * KÔKÔ V3.9 — Annulation, remboursement & réconciliation
 *
 * Prototype. Ce module trace les demandes financières et leur rapprochement.
 * Il ne déplace aucun argent réel.
 *
 * Production:
 * - brancher le PSP réellement choisi (Wave, Orange Money, MTN, Moov, etc.)
 * - vérifier signatures/webhooks et idempotence
 * - appliquer les règles contractuelles et légales validées
 * - réconciliation bancaire/PSP automatisée + contrôle humain des exceptions
 */

const express = require("express");
const router = express.Router();

function now() { return new Date().toISOString(); }

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cancellation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      contract_id INTEGER,
      requested_by_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED',
      decision_note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS refund_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cancellation_id INTEGER,
      payment_intent_id INTEGER,
      request_id INTEGER,
      client_user_id INTEGER NOT NULL,
      professional_user_id INTEGER,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'XOF',
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED',
      provider TEXT,
      provider_reference TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      failure_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS refund_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      actor_user_id INTEGER,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_reconciliation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_intent_id INTEGER,
      refund_id INTEGER,
      provider TEXT,
      provider_reference TEXT,
      expected_amount INTEGER,
      observed_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN',
      note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
}

function authRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "AUTH_REQUIRED" });
  next();
}

function isAdmin(req) {
  return req.user && (req.user.role === "admin" || req.user.role === "ADMIN");
}

module.exports = function mountV39({ app, db }) {
  ensureTables(db);

  // Client requests cancellation.
  app.post("/api/cancellations", authRequired, (req, res) => {
    const { request_id, contract_id, reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: "REASON_REQUIRED" });

    const info = db.prepare(`
      INSERT INTO cancellation_requests
      (request_id, contract_id, requested_by_user_id, reason, status, created_at)
      VALUES (?, ?, ?, ?, 'REQUESTED', ?)
    `).run(request_id || null, contract_id || null, req.user.id, reason, now());

    res.status(201).json({ id: info.lastInsertRowid, status: "REQUESTED" });
  });

  // User sees own cancellation requests.
  app.get("/api/cancellations", authRequired, (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM cancellation_requests
      WHERE requested_by_user_id = ?
      ORDER BY id DESC
    `).all(req.user.id);
    res.json(rows);
  });

  // Admin decides cancellation.
  app.post("/api/admin/cancellations/:id/decision", authRequired, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "ADMIN_REQUIRED" });

    const { decision, note } = req.body || {};
    if (!["APPROVED", "REJECTED", "CANCELLED"].includes(decision)) {
      return res.status(400).json({ error: "INVALID_DECISION" });
    }

    const info = db.prepare(`
      UPDATE cancellation_requests
      SET status = ?, decision_note = ?, decided_at = ?
      WHERE id = ?
    `).run(decision, note || null, now(), req.params.id);

    res.json({ updated: info.changes === 1, status: decision });
  });

  // Create a refund request. No real provider call.
  app.post("/api/refunds", authRequired, (req, res) => {
    const {
      cancellation_id, payment_intent_id, request_id,
      professional_user_id, amount, reason, provider
    } = req.body || {};

    if (!Number.isInteger(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: "INVALID_AMOUNT" });
    }
    if (!reason) return res.status(400).json({ error: "REASON_REQUIRED" });

    const info = db.prepare(`
      INSERT INTO refund_requests
      (cancellation_id, payment_intent_id, request_id, client_user_id,
       professional_user_id, amount, currency, reason, status, provider, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'XOF', ?, 'REQUESTED', ?, ?)
    `).run(
      cancellation_id || null, payment_intent_id || null, request_id || null,
      req.user.id, professional_user_id || null, Number(amount),
      reason, provider || null, now()
    );

    db.prepare(`
      INSERT INTO refund_events (refund_id, actor_user_id, event_type, payload, created_at)
      VALUES (?, ?, 'REFUND_REQUESTED', ?, ?)
    `).run(info.lastInsertRowid, req.user.id, JSON.stringify({ amount: Number(amount) }), now());

    res.status(201).json({
      id: info.lastInsertRowid,
      status: "REQUESTED",
      money_movement: "NONE_IN_PROTOTYPE"
    });
  });

  app.get("/api/refunds", authRequired, (req, res) => {
    const rows = isAdmin(req)
      ? db.prepare(`SELECT * FROM refund_requests ORDER BY id DESC`).all()
      : db.prepare(`
          SELECT * FROM refund_requests
          WHERE client_user_id = ?
          ORDER BY id DESC
        `).all(req.user.id);
    res.json(rows);
  });

  app.get("/api/refunds/:id/events", authRequired, (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM refund_events WHERE refund_id = ? ORDER BY id ASC
    `).all(req.params.id);
    res.json(rows);
  });

  // Admin approval/rejection.
  app.post("/api/admin/refunds/:id/decision", authRequired, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "ADMIN_REQUIRED" });

    const { decision, note } = req.body || {};
    if (!["APPROVED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ error: "INVALID_DECISION" });
    }

    const info = db.prepare(`
      UPDATE refund_requests
      SET status = ?
      WHERE id = ?
    `).run(decision, req.params.id);

    db.prepare(`
      INSERT INTO refund_events (refund_id, actor_user_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.params.id, req.user.id,
      decision === "APPROVED" ? "REFUND_APPROVED" : "REFUND_REJECTED",
      JSON.stringify({ note: note || null }),
      now()
    );

    res.json({ updated: info.changes === 1, status: decision });
  });

  // Simulated processing only in non-production.
  app.post("/api/refunds/:id/simulate-success", authRequired, (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "SIMULATOR_DISABLED_IN_PRODUCTION" });
    }

    const ref = `SIM-REFUND-${Date.now()}-${req.params.id}`;
    const info = db.prepare(`
      UPDATE refund_requests
      SET status = 'SUCCESS', provider = COALESCE(provider, 'SIMULATOR'),
          provider_reference = ?, processed_at = ?
      WHERE id = ? AND status = 'APPROVED'
    `).run(ref, now(), req.params.id);

    if (!info.changes) return res.status(409).json({ error: "REFUND_NOT_APPROVED" });

    db.prepare(`
      INSERT INTO refund_events (refund_id, actor_user_id, event_type, payload, created_at)
      VALUES (?, ?, 'REFUND_SUCCESS', ?, ?)
    `).run(req.params.id, req.user.id, JSON.stringify({ provider_reference: ref }), now());

    res.json({ status: "SUCCESS", provider_reference: ref, money_movement: "SIMULATED" });
  });

  // Reconciliation record.
  app.post("/api/admin/reconciliation", authRequired, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "ADMIN_REQUIRED" });

    const {
      payment_intent_id, refund_id, provider, provider_reference,
      expected_amount, observed_amount, status, note
    } = req.body || {};

    const info = db.prepare(`
      INSERT INTO payment_reconciliation
      (payment_intent_id, refund_id, provider, provider_reference,
       expected_amount, observed_amount, status, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payment_intent_id || null, refund_id || null, provider || null,
      provider_reference || null, expected_amount || null, observed_amount || null,
      status || 'OPEN', note || null, now()
    );

    res.status(201).json({ id: info.lastInsertRowid });
  });

  app.get("/api/admin/reconciliation", authRequired, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "ADMIN_REQUIRED" });
    res.json(db.prepare(`
      SELECT * FROM payment_reconciliation ORDER BY id DESC
    `).all());
  });

  app.post("/api/admin/reconciliation/:id/resolve", authRequired, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "ADMIN_REQUIRED" });

    const info = db.prepare(`
      UPDATE payment_reconciliation
      SET status = 'RESOLVED', note = COALESCE(?, note), resolved_at = ?
      WHERE id = ?
    `).run(req.body?.note || null, now(), req.params.id);

    res.json({ updated: info.changes === 1, status: "RESOLVED" });
  });
};
