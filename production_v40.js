/**
 * KÔKÔ V4.0 — Préparation production
 *
 * Ce module fournit des contrôles de santé et une base de checklist.
 * Il ne remplace pas un audit de sécurité ni une configuration serveur réelle.
 */

function mountProductionV40({app, db}) {
  function isAdmin(req) {
    return req.user && (req.user.role === "admin" || req.user.role === "ADMIN");
  }

  app.get("/api/health", (req,res) => {
    let database = "ok";
    try { db.prepare("SELECT 1 AS ok").get(); }
    catch(e) { database = "error"; }

    const production = process.env.NODE_ENV === "production";
    const checks = {
      database,
      https_expected: production,
      debug_disabled: !production || process.env.DEBUG !== "true",
      payment_simulator_disabled: !production || process.env.PAYMENT_PROVIDER !== "SIMULATOR",
      environment: production ? "production" : "non-production"
    };

    const healthy = database === "ok";
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      checks,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/admin/production-readiness", (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({error:"ADMIN_REQUIRED"});

    const production = process.env.NODE_ENV === "production";
    const checks = [
      {
        key:"NODE_ENV",
        label:"Environnement explicite",
        ok: !!process.env.NODE_ENV
      },
      {
        key:"JWT_SECRET",
        label:"Secret JWT configuré",
        ok: !!process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
      },
      {
        key:"SESSION_SECRET",
        label:"Secret de session configuré",
        ok: !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
      },
      {
        key:"APP_BASE_URL",
        label:"URL publique configurée",
        ok: !!process.env.APP_BASE_URL
      },
      {
        key:"PAYMENT_PROVIDER",
        label:"Prestataire de paiement configuré",
        ok: !!process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== "SIMULATOR"
      },
      {
        key:"PAYMENT_WEBHOOK_SECRET",
        label:"Secret webhook paiement configuré",
        ok: !!process.env.PAYMENT_WEBHOOK_SECRET
      },
      {
        key:"STORAGE_PROVIDER",
        label:"Stockage privé configuré",
        ok: !!process.env.STORAGE_PROVIDER
      },
      {
        key:"HTTPS",
        label:"HTTPS attendu en production",
        ok: !production || process.env.APP_BASE_URL?.startsWith("https://")
      }
    ];

    const passed = checks.filter(c=>c.ok).length;
    res.json({
      version:"4.0",
      production,
      passed,
      total:checks.length,
      ready_for_public_launch: production && passed === checks.length,
      checks
    });
  });
}

module.exports = { mountProductionV40 };
