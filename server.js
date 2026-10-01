const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");

// ================= KÔKÔ — INITIALISATION CENTRALE =================
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_BEFORE_PRODUCTION";
const db = new Database("koko.sqlite");
db.pragma("journal_mode = WAL");

app.use(cors());
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

const uploadDir = path.join(__dirname, "uploads", "evidence");
fs.mkdirSync(uploadDir, { recursive: true });
const evidenceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || "photo").replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2,9) + "-" + safe);
  }
});
const evidenceUpload = multer({
  storage: evidenceStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req,file,cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null,true);
    else cb(new Error("Format image non autorisé"));
  }
});
app.use("/uploads", express.static(path.join(__dirname,"uploads")));






// ================= KÔKÔ V3.1 — PARCOURS JURIDIQUE =================
function currentLegalDocument(slug){
  return db.prepare(`SELECT * FROM legal_documents WHERE slug=? AND status IN ('PUBLISHED','LEGAL_REVIEW_REQUIRED') ORDER BY id DESC LIMIT 1`).get(slug);
}
function hasAcceptedLegal(userId, slug){
  const d=currentLegalDocument(slug);
  if(!d) return false;
  return !!db.prepare(`SELECT 1 FROM legal_acceptances WHERE user_id=? AND legal_document_id=? AND version=? LIMIT 1`).get(userId,d.id,d.version);
}

app.get('/api/legal/documents', (req,res)=>{
  const rows=db.prepare(`SELECT slug,title,document_type,version,status,country,language,published_at,created_at
    FROM legal_documents WHERE status IN ('PUBLISHED','LEGAL_REVIEW_REQUIRED') ORDER BY document_type`).all();
  res.json({country:LEGAL_COUNTRY,currency:LEGAL_CURRENCY,language:LEGAL_LANGUAGE,documents:rows});
});

app.get('/api/legal/documents/:slug', (req,res)=>{
  const d=currentLegalDocument(req.params.slug);
  if(!d) return res.status(404).json({error:'Document juridique introuvable'});
  res.json({document:d,legal_review_required:d.status!=='PUBLISHED'});
});

app.post('/api/legal/accept', auth, (req,res)=>{
  const slug=String(req.body?.slug||'').trim();
  if(!slug) return res.status(400).json({error:'slug requis'});
  const d=currentLegalDocument(slug);
  if(!d) return res.status(404).json({error:'Document juridique introuvable'});
  if(d.status!=='PUBLISHED') return res.status(409).json({error:'Ce document est encore en validation juridique. Il ne peut pas être présenté comme une version contractuelle définitive.'});
  const existing=db.prepare(`SELECT * FROM legal_acceptances WHERE user_id=? AND legal_document_id=? AND version=?`).get(req.user.id,d.id,d.version);
  if(!existing){
    db.prepare(`INSERT INTO legal_acceptances(user_id,legal_document_id,version,evidence_note) VALUES(?,?,?,?,?)`)
      .run(req.user.id,d.id,d.version,req.body?.evidence_note||'Acceptation via KÔKÔ');
    db.prepare(`INSERT INTO legal_events(legal_document_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
      .run(d.id,req.user.id,'DOCUMENT_ACCEPTED',JSON.stringify({version:d.version,slug}));
  }
  res.json({ok:true,slug,version:d.version,accepted:true});
});

app.get('/api/legal/acceptances/me', auth, (req,res)=>{
  const rows=db.prepare(`SELECT a.id,a.version,a.accepted_at,d.slug,d.title,d.document_type
    FROM legal_acceptances a JOIN legal_documents d ON d.id=a.legal_document_id
    WHERE a.user_id=? ORDER BY a.accepted_at DESC`).all(req.user.id);
  res.json(rows);
});

app.get('/api/legal/check', auth, (req,res)=>{
  const slugs=['cgu','confidentialite','paiement','litiges'];
  const result={}; for(const slug of slugs) result[slug]=hasAcceptedLegal(req.user.id,slug);
  res.json(result);
});

app.post('/api/admin/legal/publish/:id', auth, (req,res)=>{
  if(!['admin','ADMIN'].includes(String(req.user.role))) return res.status(403).json({error:'Accès administrateur requis'});
  const d=db.prepare(`SELECT * FROM legal_documents WHERE id=?`).get(Number(req.params.id));
  if(!d) return res.status(404).json({error:'Document introuvable'});
  db.prepare(`UPDATE legal_documents SET status='PUBLISHED',published_at=CURRENT_TIMESTAMP WHERE id=?`).run(d.id);
  db.prepare(`INSERT INTO legal_events(legal_document_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(d.id,req.user.id,'DOCUMENT_PUBLISHED',JSON.stringify({version:d.version}));
  res.json({ok:true});
});

app.get('/api/admin/legal/events', auth, (req,res)=>{
  if(!['admin','ADMIN'].includes(String(req.user.role))) return res.status(403).json({error:'Accès administrateur requis'});
  res.json(db.prepare(`SELECT * FROM legal_events ORDER BY created_at DESC LIMIT 500`).all());
});

// ================= KÔKÔ V1.3 — NOTIFICATIONS INTELLIGENTES =================
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  request_id INTEGER,
  intervention_id INTEGER,
  conversation_id INTEGER,
  read_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function createKokoNotification(userId, type, title, body, meta={}){
  if(!userId) return;
  // Compatibilité avec les anciens appels :
  // createKokoNotification(user,type,title,body,requestId,interventionId,conversationId)
  if(typeof meta !== 'object' || meta === null){
    meta={request_id:meta||null,intervention_id:arguments[5]||null,conversation_id:arguments[6]||null};
  }
  db.prepare(`INSERT INTO notifications
    (user_id,type,title,body,request_id,intervention_id,conversation_id)
    VALUES(?,?,?,?,?,?,?)`)
    .run(userId,type,title,body,meta.request_id||null,meta.intervention_id||null,meta.conversation_id||null);
}

// ================= KÔKÔ V1.2 — MESSAGERIE =================
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, professional_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_user_id INTEGER NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'TEXT',
  body TEXT,
  attachment_url TEXT,
  attachment_name TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ================= KÔKÔ V1.1 — GÉOLOCALISATION =================
function addColumnIfMissing(table, column, definition){
  const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
  if(!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ================= KÔKÔ V1.0 — INTERVENTIONS =================
db.exec(`
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL UNIQUE,
  quote_id INTEGER,
  professional_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  scheduled_date TEXT,
  scheduled_time TEXT,
  address TEXT,
  client_note TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  started_at TEXT,
  arrived_at TEXT,
  completed_at TEXT,
  client_confirmed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS intervention_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intervention_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);


// ========================= V3.0 — SOCLE JURIDIQUE CÔTE D'IVOIRE =========================
// Prototype: les documents juridiques sont versionnés et explicitement marqués
// comme nécessitant une validation juridique avant production.
const LEGAL_COUNTRY = 'CI';
const LEGAL_CURRENCY = 'XOF';
const LEGAL_LANGUAGE = 'fr';

const legalDocsSeed = [
  ['cgu', 'Conditions Générales d’Utilisation KÔKÔ', 'CGU', 'LEGAL_REVIEW_REQUIRED'],
  ['contrat-client-professionnel', 'Modèle de contrat Client ↔ Professionnel', 'CONTRACT', 'LEGAL_REVIEW_REQUIRED'],
  ['conditions-btp', 'Conditions particulières des prestations BTP', 'SERVICE_TERMS', 'LEGAL_REVIEW_REQUIRED'],
  ['confidentialite', 'Politique de confidentialité et données personnelles', 'PRIVACY', 'LEGAL_REVIEW_REQUIRED'],
  ['kyc', 'Politique de vérification professionnelle (KYC)', 'KYC', 'LEGAL_REVIEW_REQUIRED'],
  ['paiement', 'Politique de paiement', 'PAYMENT', 'LEGAL_REVIEW_REQUIRED'],
  ['annulation-remboursement', 'Politique d’annulation et de remboursement', 'REFUND', 'LEGAL_REVIEW_REQUIRED'],
  ['litiges', 'Procédure de réclamation et de règlement des litiges', 'DISPUTE', 'LEGAL_REVIEW_REQUIRED'],
  ['preuve-electronique', 'Politique de preuve et signature électronique', 'EVIDENCE', 'LEGAL_REVIEW_REQUIRED'],
  ['archivage', 'Politique d’archivage électronique', 'ARCHIVE', 'LEGAL_REVIEW_REQUIRED'],
  ['mentions-legales', 'Mentions légales KÔKÔ', 'LEGAL_NOTICE', 'LEGAL_REVIEW_REQUIRED']
];

function initLegalV30(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      document_type TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'LEGAL_REVIEW_REQUIRED',
      content TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'CI',
      language TEXT NOT NULL DEFAULT 'fr',
      published_at DATETIME,
      archived_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, version)
    );
    CREATE TABLE IF NOT EXISTS legal_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      legal_document_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      evidence_note TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(legal_document_id) REFERENCES legal_documents(id)
    );
    CREATE TABLE IF NOT EXISTS legal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legal_document_id INTEGER,
      actor_user_id INTEGER,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const count=db.prepare('SELECT COUNT(*) c FROM legal_documents').get().c;
  if(!count){
    const docs={
      'cgu':'KÔKÔ est une plateforme de mise en relation et de suivi de prestations. Le rôle exact de KÔKÔ doit être arrêté juridiquement avant lancement.',
      'contrat-client-professionnel':'Document-cadre pour définir les parties, la prestation, le prix en XOF, les délais, obligations, réserves, garantie et fin de contrat.',
      'conditions-btp':'Règles particulières pour travaux de construction, rénovation, étanchéité, peinture, carrelage et autres prestations concernées.',
      'confidentialite':'Document à finaliser selon les traitements réels, finalités, bases juridiques, droits des personnes, durées de conservation, sous-traitants et transferts.',
      'kyc':'Règles de collecte minimale, vérification et renouvellement des professionnels. Les pièces sensibles doivent rester dans un stockage privé sécurisé.',
      'paiement':'Décrit le rôle de KÔKÔ et du prestataire de paiement. KÔKÔ ne doit pas se présenter comme établissement de paiement ou séquestre sans cadre approprié.',
      'annulation-remboursement':'Définit les cas d’annulation, remboursement et frais selon la nature de la prestation et les contrats applicables.',
      'litiges':'Décrit réclamation, collecte des preuves, réponse du professionnel, décision et voies de recours à préciser juridiquement.',
      'preuve-electronique':'Prévoit version, horodatage, intégrité et conservation des actes. Une signature électronique qualifiée ne doit pas être simulée par KÔKÔ.',
      'archivage':'Définit conservation, accessibilité, intégrité, traçabilité et restitution des documents selon les exigences applicables.',
      'mentions-legales':'À compléter avec identité exacte de l’éditeur, coordonnées, hébergeur, responsable de publication et autres mentions obligatoires.'
    };
    const ins=db.prepare(`INSERT INTO legal_documents(slug,title,document_type,version,status,content,country,language) VALUES(?,?,?,?,?,?,?,?)`);
    for(const [slug,title,type,status] of legalDocsSeed) ins.run(slug,title,type,'0.1',status,docs[slug]||'',LEGAL_COUNTRY,LEGAL_LANGUAGE);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'client',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS professionals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER UNIQUE NOT NULL,
 business_name TEXT NOT NULL,
 category TEXT NOT NULL,
 zone TEXT NOT NULL,
 description TEXT,
 verified INTEGER NOT NULL DEFAULT 0,
 rating REAL NOT NULL DEFAULT 0,
 review_count INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 client_id INTEGER NOT NULL,
 category TEXT NOT NULL,
 description TEXT NOT NULL,
 zone TEXT NOT NULL,
 preferred_time TEXT,
 status TEXT NOT NULL DEFAULT 'OPEN',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(client_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS quotes(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER NOT NULL,
 professional_id INTEGER NOT NULL,
 amount INTEGER NOT NULL,
 message TEXT,
 estimated_time TEXT,
 status TEXT NOT NULL DEFAULT 'PENDING',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(request_id) REFERENCES requests(id),
 FOREIGN KEY(professional_id) REFERENCES professionals(id)
);
CREATE TABLE IF NOT EXISTS reviews(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER NOT NULL,
 client_id INTEGER NOT NULL,
 professional_id INTEGER NOT NULL,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professional_documents(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 professional_id INTEGER NOT NULL,
 document_type TEXT NOT NULL,
 document_ref TEXT,
 status TEXT NOT NULL DEFAULT 'PENDING',
 note TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(professional_id) REFERENCES professionals(id)
);
CREATE TABLE IF NOT EXISTS professional_projects(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 professional_id INTEGER NOT NULL,
 title TEXT NOT NULL,
 description TEXT,
 category TEXT,
 photo_url TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(professional_id) REFERENCES professionals(id)
);

CREATE TABLE IF NOT EXISTS intervention_evidence(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER NOT NULL,
 actor_user_id INTEGER NOT NULL,
 evidence_type TEXT NOT NULL,
 photo_url TEXT,
 note TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(request_id) REFERENCES requests(id),
 FOREIGN KEY(actor_user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS intervention_confirmations(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER UNIQUE NOT NULL,
 client_id INTEGER NOT NULL,
 confirmed INTEGER NOT NULL DEFAULT 0,
 comment TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(request_id) REFERENCES requests(id),
 FOREIGN KEY(client_id) REFERENCES users(id)
);
`);

// ================= KÔKÔ — MIGRATION DE COMPATIBILITÉ V4.x =================
function addColumnIfMissing(table, column, definition){
  const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
  if(!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Compatibilité des versions précédentes : ces alias permettent aux modules V1→V4
// de partager un même socle de données sans casser les anciennes installations.
addColumnIfMissing('users','email','TEXT');
addColumnIfMissing('users','latitude','REAL');
addColumnIfMissing('users','longitude','REAL');

addColumnIfMissing('professionals','name','TEXT');
addColumnIfMissing('professionals','company_name','TEXT');
addColumnIfMissing('professionals','availability',"TEXT DEFAULT 'AVAILABLE'");
addColumnIfMissing('professionals','services','TEXT');
addColumnIfMissing('professionals','location','TEXT');
addColumnIfMissing('professionals','last_seen_at','TEXT');
addColumnIfMissing('professionals','service_radius_km','REAL DEFAULT 15');
addColumnIfMissing('professionals','created_at','TEXT');

addColumnIfMissing('requests','user_id','INTEGER');
addColumnIfMissing('requests','title','TEXT');
addColumnIfMissing('requests','problem','TEXT');
addColumnIfMissing('requests','service','TEXT');
addColumnIfMissing('requests','location','TEXT');
addColumnIfMissing('requests','budget','INTEGER');

addColumnIfMissing('professional_documents','review_note','TEXT');
addColumnIfMissing('professional_documents','reviewed_at','TEXT');

// Backfill des alias pour les anciennes données.
db.exec(`
  UPDATE professionals SET
    name=COALESCE(NULLIF(name,''),business_name),
    company_name=COALESCE(NULLIF(company_name,''),business_name),
    location=COALESCE(NULLIF(location,''),zone),
    services=COALESCE(NULLIF(services,''),category),
    availability=COALESCE(NULLIF(availability,''),'AVAILABLE'),
    created_at=COALESCE(created_at,CURRENT_TIMESTAMP);
  UPDATE requests SET
    user_id=COALESCE(user_id,client_id),
    title=COALESCE(NULLIF(title,''),category),
    problem=COALESCE(NULLIF(problem,''),description),
    service=COALESCE(NULLIF(service,''),category),
    location=COALESCE(NULLIF(location,''),zone);
`);

// Table utilisée par les anciennes routes de matching. Les nouvelles routes
// utilisent directement professionals.availability.
db.exec(`CREATE TABLE IF NOT EXISTS professional_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professional_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

initLegalV30(db);

function auth(req,res,next){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Authentification requise"});
 try{req.user=jwt.verify(h.slice(7),JWT_SECRET);next()}
 catch(e){return res.status(401).json({error:"Session invalide"})}
}
function optionalAuth(req,res,next){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) { req.user=null; return next(); }
 try{ req.user=jwt.verify(h.slice(7),JWT_SECRET); next(); }
 catch(e){ req.user=null; next(); }
}
function token(user){return jwt.sign({id:user.id,role:user.role,name:user.name},JWT_SECRET,{expiresIn:"7d"})}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"KÔKÔ",version:"0.1.0"}));

app.post("/api/auth/register",(req,res)=>{
 const {name,phone,password,role="client"}=req.body;
 if(!name||!phone||!password) return res.status(400).json({error:"Nom, téléphone et mot de passe requis"});
 if(!["client","professional"].includes(role)) return res.status(400).json({error:"Rôle invalide"});
 try{
   const hash=bcrypt.hashSync(password,10);
   const info=db.prepare("INSERT INTO users(name,phone,password_hash,role) VALUES(?,?,?,?)").run(name,phone,hash,role);
   const user=db.prepare("SELECT id,name,phone,role FROM users WHERE id=?").get(info.lastInsertRowid);
   res.status(201).json({user,token:token(user)});
 }catch(e){res.status(409).json({error:"Ce numéro est déjà utilisé"})}
});

app.post("/api/auth/login",(req,res)=>{
 const {phone,password}=req.body;
 const user=db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
 if(!user||!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:"Identifiants incorrects"});
 res.json({user:{id:user.id,name:user.name,phone:user.phone,role:user.role},token:token(user)});
});

app.get("/api/me",auth,(req,res)=>{
 const user=db.prepare("SELECT id,name,phone,role,created_at FROM users WHERE id=?").get(req.user.id);
 res.json(user);
});

app.post("/api/requests",auth,(req,res)=>{
 const {category,description,zone,preferred_time}=req.body;
 if(!category||!description||!zone) return res.status(400).json({error:"Catégorie, description et zone requis"});
 const info=db.prepare(`INSERT INTO requests(client_id,category,description,zone,preferred_time,user_id,title,problem,service,location)
 VALUES(?,?,?,?,?,?,?,?,?,?)`)
 .run(req.user.id,category,description,zone,preferred_time||null,req.user.id,category,description,category,zone);
 res.status(201).json(db.prepare("SELECT * FROM requests WHERE id=?").get(info.lastInsertRowid));
});

app.get("/api/requests",auth,(req,res)=>{
 const rows=req.user.role==="client"
 ? db.prepare("SELECT * FROM requests WHERE client_id=? ORDER BY id DESC").all(req.user.id)
 : db.prepare(`SELECT r.*,q.id AS quote_id,q.amount,q.status AS quote_status
               FROM requests r LEFT JOIN quotes q ON q.request_id=r.id
               WHERE r.status!='CLOSED' ORDER BY r.id DESC`).all();
 res.json(rows);
});

app.get("/api/professionals",(req,res)=>{
 const {category,zone}=req.query;
 let sql=`SELECT p.id,p.business_name,p.category,p.zone,p.description,p.verified,p.rating,p.review_count
          FROM professionals p WHERE 1=1`;
 const args=[];
 if(category){sql+=" AND p.category=?";args.push(category)}
 if(zone){sql+=" AND p.zone LIKE ?";args.push("%"+zone+"%")}
 sql+=" ORDER BY p.verified DESC,p.rating DESC";
 res.json(db.prepare(sql).all(...args));
});

app.post("/api/professionals",auth,(req,res)=>{
 if(req.user.role!=="professional") return res.status(403).json({error:"Réservé aux professionnels"});
 const {business_name,category,zone,description=""}=req.body;
 if(!business_name||!category||!zone) return res.status(400).json({error:"Informations professionnelles incomplètes"});
 const info=db.prepare(`INSERT INTO professionals(user_id,business_name,category,zone,description,name,company_name,availability,services,location,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
 ON CONFLICT(user_id) DO UPDATE SET
   business_name=excluded.business_name, category=excluded.category, zone=excluded.zone, description=excluded.description,
   name=excluded.name, company_name=excluded.company_name, services=excluded.services, location=excluded.location`).run(
   req.user.id,business_name,category,zone,description,business_name,business_name,'AVAILABLE',category,zone);
 res.status(201).json(db.prepare("SELECT * FROM professionals WHERE user_id=?").get(req.user.id));
});

app.post("/api/quotes",auth,(req,res)=>{
 if(req.user.role!=="professional") return res.status(403).json({error:"Réservé aux professionnels"});
 const pro=db.prepare("SELECT * FROM professionals WHERE user_id=?").get(req.user.id);
 if(!pro) return res.status(400).json({error:"Profil professionnel à créer"});
 const {request_id,amount,message="",estimated_time=""}=req.body;
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(request_id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 const info=db.prepare(`INSERT INTO quotes(request_id,professional_id,amount,message,estimated_time)
 VALUES(?,?,?,?,?)`).run(request_id,pro.id,amount,message,estimated_time);
 res.status(201).json(db.prepare("SELECT * FROM quotes WHERE id=?").get(info.lastInsertRowid));
});

app.get("/api/requests/:id/quotes",auth,(req,res)=>{
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 const quotes=db.prepare(`SELECT q.*,p.business_name,p.zone,p.verified,p.rating,p.review_count
 FROM quotes q JOIN professionals p ON p.id=q.professional_id WHERE q.request_id=? ORDER BY q.amount ASC`).all(req.params.id);
 res.json(quotes);
});


// ================= KÔKÔ V0.9 — SYSTÈME DE DEVIS =================

app.get('/api/requests/:id/quotes/compare', auth, (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const request = db.prepare(`
      SELECT r.*, u.name AS client_name
      FROM requests r JOIN users u ON u.id = r.client_id
      WHERE r.id = ?
    `).get(requestId);
    if (!request) return res.status(404).json({error:'Demande introuvable'});

    const quotes = db.prepare(`
      SELECT q.*,
             p.id AS professional_id, p.company_name, p.category, p.zone,
             p.verified, p.rating, p.availability,
             u.name AS professional_name
      FROM quotes q
      JOIN professionals p ON p.id = q.professional_id
      JOIN users u ON u.id = p.user_id
      WHERE q.request_id = ?
      ORDER BY q.amount ASC, q.created_at ASC
    `).all(requestId);

    res.json({request, quotes});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/quotes/:id/withdraw', auth, (req,res) => {
  try {
    const id = Number(req.params.id);
    const q = db.prepare(`
      SELECT q.*, p.user_id AS professional_user_id
      FROM quotes q JOIN professionals p ON p.id=q.professional_id
      WHERE q.id=?
    `).get(id);
    if (!q) return res.status(404).json({error:'Devis introuvable'});
    if (q.professional_user_id !== req.user.id) return res.status(403).json({error:'Accès refusé'});
    if (q.status !== 'PENDING') return res.status(400).json({error:'Ce devis ne peut plus être retiré'});
    db.prepare(`UPDATE quotes SET status='WITHDRAWN' WHERE id=?`).run(id);
    res.json({ok:true});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/requests/:id/close-quotes', auth, (req,res) => {
  try {
    const id = Number(req.params.id);
    const r = db.prepare(`SELECT * FROM requests WHERE id=?`).get(id);
    if (!r) return res.status(404).json({error:'Demande introuvable'});
    if (r.client_id !== req.user.id) return res.status(403).json({error:'Accès refusé'});
    db.prepare(`UPDATE quotes SET status='EXPIRED' WHERE request_id=? AND status='PENDING'`).run(id);
    res.json({ok:true});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/quotes/:id/accept",auth,(req,res)=>{
 const quote=db.prepare("SELECT q.*,r.client_id FROM quotes q JOIN requests r ON r.id=q.request_id WHERE q.id=?").get(req.params.id);
 if(!quote||quote.client_id!==req.user.id) return res.status(403).json({error:"Action non autorisée"});
 db.transaction(()=>{
   db.prepare("UPDATE quotes SET status='REJECTED' WHERE request_id=?").run(quote.request_id);
   db.prepare("UPDATE quotes SET status='ACCEPTED' WHERE id=?").run(quote.id);
   db.prepare("UPDATE requests SET status='CONFIRMED' WHERE id=?").run(quote.request_id);
 })();
 
    const acceptedQuote=db.prepare(`SELECT q.request_id,p.user_id professional_user_id,r.client_id
      FROM quotes q JOIN professionals p ON p.id=q.professional_id JOIN requests r ON r.id=q.request_id
      WHERE q.id=?`).get(Number(req.params.id));
    if(acceptedQuote){
      createKokoNotification(acceptedQuote.professional_user_id,'QUOTE_ACCEPTED','Devis accepté','Votre devis a été accepté par le client.',{request_id:acceptedQuote.request_id});
    }
res.json({ok:true,status:"CONFIRMED"});
});

app.post("/api/requests/:id/status",auth,(req,res)=>{
 const allowed=["OPEN","CONFIRMED","ON_ROUTE","ARRIVED","IN_PROGRESS","COMPLETED","CLOSED"];
 const {status}=req.body;
 if(!allowed.includes(status)) return res.status(400).json({error:"Statut invalide"});
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 if(req.user.id!==request.client_id && req.user.role!=="professional" && req.user.role!=="admin")
   return res.status(403).json({error:"Action non autorisée"});
 db.prepare("UPDATE requests SET status=? WHERE id=?").run(status,req.params.id);
 res.json(db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id));
});

app.post("/api/reviews",auth,(req,res)=>{
 const {request_id,professional_id,rating,comment=""}=req.body;
 if(!Number.isInteger(rating)||rating<1||rating>5) return res.status(400).json({error:"Note de 1 à 5"});
 const request=db.prepare("SELECT * FROM requests WHERE id=? AND client_id=?").get(request_id,req.user.id);
 if(!request) return res.status(403).json({error:"Demande non autorisée"});
 db.prepare("INSERT INTO reviews(request_id,client_id,professional_id,rating,comment) VALUES(?,?,?,?,?)")
 .run(request_id,req.user.id,professional_id,rating,comment);
 const avg=db.prepare("SELECT AVG(rating) a,COUNT(*) n FROM reviews WHERE professional_id=?").get(professional_id);
 db.prepare("UPDATE professionals SET rating=?,review_count=? WHERE id=?").run(Number(avg.a.toFixed(2)),avg.n,professional_id);
 res.status(201).json({ok:true,rating:avg.a,review_count:avg.n});
});


app.get("/api/professionals/:id",async(req,res)=>{
 const p=db.prepare(`SELECT p.*,u.name,u.phone FROM professionals p JOIN users u ON u.id=p.user_id WHERE p.id=?`).get(req.params.id);
 if(!p) return res.status(404).json({error:"Professionnel introuvable"});
 const docs=db.prepare("SELECT id,document_type,status,note FROM professional_documents WHERE professional_id=? ORDER BY id DESC").all(p.id);
 const projects=db.prepare("SELECT id,title,description,category,photo_url,created_at FROM professional_projects WHERE professional_id=? ORDER BY id DESC").all(p.id);
 const reviews=db.prepare(`SELECT r.rating,r.comment,r.created_at,u.name AS client_name
                           FROM reviews r JOIN users u ON u.id=r.client_id
                           WHERE r.professional_id=? ORDER BY r.id DESC LIMIT 20`).all(p.id);
 res.json({...p,documents:docs,projects,reviews});
});

app.post("/api/professional/documents",auth,(req,res)=>{
 if(req.user.role!=="professional") return res.status(403).json({error:"Compte professionnel requis"});
 const p=db.prepare("SELECT id FROM professionals WHERE user_id=?").get(req.user.id);
 if(!p) return res.status(400).json({error:"Créez d'abord votre profil professionnel"});
 const {document_type,document_ref=""}=req.body;
 if(!document_type) return res.status(400).json({error:"Type de document requis"});
 const info=db.prepare("INSERT INTO professional_documents(professional_id,document_type,document_ref) VALUES(?,?,?)")
   .run(p.id,document_type,document_ref);
 res.status(201).json(db.prepare("SELECT * FROM professional_documents WHERE id=?").get(info.lastInsertRowid));
});

app.post("/api/professional/projects",auth,(req,res)=>{
 if(req.user.role!=="professional") return res.status(403).json({error:"Compte professionnel requis"});
 const p=db.prepare("SELECT id FROM professionals WHERE user_id=?").get(req.user.id);
 if(!p) return res.status(400).json({error:"Créez d'abord votre profil professionnel"});
 const {title,description="",category="",photo_url=""}=req.body;
 if(!title) return res.status(400).json({error:"Titre requis"});
 const info=db.prepare("INSERT INTO professional_projects(professional_id,title,description,category,photo_url) VALUES(?,?,?,?,?)")
   .run(p.id,title,description,category,photo_url);
 res.status(201).json(db.prepare("SELECT * FROM professional_projects WHERE id=?").get(info.lastInsertRowid));
});

app.post("/api/requests/:id/evidence",auth,(req,res)=>{
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 if(req.user.id!==request.client_id && req.user.role!=="professional" && req.user.role!=="admin")
   return res.status(403).json({error:"Action non autorisée"});
 const {evidence_type,photo_url="",note=""}=req.body;
 if(!["BEFORE","AFTER","ARRIVAL","PROOF"].includes(evidence_type))
   return res.status(400).json({error:"Type de preuve invalide"});
 const info=db.prepare(`INSERT INTO intervention_evidence(request_id,actor_user_id,evidence_type,photo_url,note)
                        VALUES(?,?,?,?,?)`).run(req.params.id,req.user.id,evidence_type,photo_url,note);
 res.status(201).json(db.prepare("SELECT * FROM intervention_evidence WHERE id=?").get(info.lastInsertRowid));
});

app.get("/api/requests/:id/evidence",auth,(req,res)=>{
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 if(req.user.id!==request.client_id && req.user.role!=="professional" && req.user.role!=="admin")
   return res.status(403).json({error:"Action non autorisée"});
 res.json(db.prepare(`SELECT e.*,u.name AS actor_name FROM intervention_evidence e
                       JOIN users u ON u.id=e.actor_user_id
                       WHERE e.request_id=? ORDER BY e.id ASC`).all(req.params.id));
});

app.post("/api/requests/:id/confirm",auth,(req,res)=>{
 const request=db.prepare("SELECT * FROM requests WHERE id=? AND client_id=?").get(req.params.id,req.user.id);
 if(!request) return res.status(403).json({error:"Demande non autorisée"});
 const {comment=""}=req.body;
 db.prepare(`INSERT INTO intervention_confirmations(request_id,client_id,confirmed,comment)
             VALUES(?,?,1,?)
             ON CONFLICT(request_id) DO UPDATE SET confirmed=1,comment=excluded.comment`).run(req.params.id,req.user.id,comment);
 db.prepare("UPDATE requests SET status='CLOSED' WHERE id=?").run(req.params.id);
 res.json({ok:true,status:"CLOSED"});
});

app.get("/api/requests/:id/history",auth,(req,res)=>{
 const request=db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
 if(!request) return res.status(404).json({error:"Demande introuvable"});
 if(req.user.id!==request.client_id && req.user.role!=="professional" && req.user.role!=="admin")
   return res.status(403).json({error:"Action non autorisée"});
 const evidence=db.prepare(`SELECT evidence_type,photo_url,note,created_at FROM intervention_evidence WHERE request_id=? ORDER BY id`).all(req.params.id);
 const confirmation=db.prepare(`SELECT confirmed,comment,created_at FROM intervention_confirmations WHERE request_id=?`).get(req.params.id);
 res.json({request,evidence,confirmation:confirmation||null});
});


// KÔKÔ V0.5 — Assistant IA (prototype sans clé API)
function kokoAiStructure(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();

  const rules = [
    {cat:"Plomberie", words:["fuite","robinet","tuyau","canalisation","évier","lavabo","wc","toilette","douche","chauffe-eau","plombier"]},
    {cat:"Électricité", words:["électricité","electrique","prise","disjoncteur","courant","panne électrique","ampoule","interrupteur"]},
    {cat:"Climatisation", words:["clim","climatisation","climatiseur","split","froid","rafraîchir","rafraichir"]},
    {cat:"Étanchéité", words:["étanchéité","infiltration","fuite toiture","toiture","terrasse","humidité","mur qui prend l'eau"]},
    {cat:"Peinture", words:["peinture","repeindre","mur","façade","plafond"]},
    {cat:"Carrelage", words:["carrelage","carreaux","faïence","sol","dallage"]},
    {cat:"Maçonnerie", words:["maçonnerie","mur","cloison","béton","dalle","fondation","construction"]},
    {cat:"Menuiserie Aluminium", words:["alu","aluminium","fenêtre","baie vitrée","porte aluminium","menuiserie"]}
  ];

  let category = null;
  for (const r of rules) {
    if (r.words.some(w => low.includes(w))) { category = r.cat; break; }
  }

  const zones = ["Cocody","Angré","Riviera","Deux-Plateaux","Marcory","Treichville","Plateau","Yopougon","Abobo","Bingerville","Port-Bouët","Koumassi","Adjamé","Anyama"];
  const location = zones.find(z => low.includes(z.toLowerCase())) || null;

  let urgency = "normale";
  if (/(urgent|urgence|immédiat|immediat|tout de suite|maintenant|aujourd'hui|aujourd’hui)/.test(low)) urgency = "urgente";
  else if (/(demain|24 ?h|rapidement|dès que possible|des que possible)/.test(low)) urgency = "rapide";

  let timing = null;
  if (/aujourd'hui|aujourd’hui/.test(low)) timing = "Aujourd'hui";
  else if (/demain/.test(low)) timing = "Demain";
  else if (/ce week-end|ce weekend/.test(low)) timing = "Ce week-end";

  const budgetMatch = low.match(/(?:budget|maximum|max|jusqu'à|jusqu a)\s*(?:de\s*)?(\d[\d\s.,]*)\s*(fcfa|f|francs)?/i);
  const budget = budgetMatch ? budgetMatch[1].replace(/\s/g,'') + " FCFA" : null;

  const missing = [];
  if (!category) missing.push("service");
  if (!location) missing.push("zone");
  if (!timing) missing.push("moment d'intervention");

  const questions = [];
  if (!location) questions.push("Dans quelle zone/quartier faut-il intervenir ?");
  if (!timing) questions.push("Quand souhaitez-vous l'intervention ?");
  if (!category) questions.push("Quel type de professionnel recherchez-vous ?");

  return {
    category, problem: t.slice(0,220), location, urgency, timing, budget,
    missing, questions, nextAction: missing.length ? "complete" : "confirm"
  };
}

app.post("/api/ai/structure", optionalAuth, (req,res) => {
  const { text } = req.body || {};
  if (!text || String(text).trim().length < 5)
    return res.status(400).json({error:"Décrivez votre besoin en quelques mots."});
  res.json({success:true, result:kokoAiStructure(text)});
});


// KÔKÔ V0.6 — Disponibilité & notifications
// La structure notifications V1.3 est la structure canonique.
function addNotification(userId, type, title, message, requestId=null) {
  createKokoNotification(userId,type,title,message,{request_id:requestId});
}

app.post("/api/pro/availability", auth, (req,res) => {
  if (!['professional','PROFESSIONAL','pro','PRO'].includes(req.user.role)) return res.status(403).json({error:"Professionnel requis"});
  const value = String(req.body.availability || '').toUpperCase();
  if (!['AVAILABLE','BUSY','OFFLINE'].includes(value)) return res.status(400).json({error:"Disponibilité invalide"});
  const pro = db.prepare("SELECT id FROM professionals WHERE user_id=?").get(req.user.id);
  if (!pro) return res.status(404).json({error:"Profil professionnel introuvable"});
  db.prepare("UPDATE professionals SET availability=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?").run(value,pro.id);
  db.prepare(`INSERT INTO professional_availability(professional_id,status,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(professional_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP`).run(pro.id,value);
  res.json({success:true,availability:value});
});

app.get("/api/pro/availability", auth, (req,res) => {
  if (!['professional','PROFESSIONAL','pro','PRO'].includes(req.user.role)) return res.status(403).json({error:"Professionnel requis"});
  const pro = db.prepare("SELECT availability,last_seen_at FROM professionals WHERE user_id=?").get(req.user.id);
  res.json(pro || {availability:"OFFLINE"});
});

// KÔKÔ V0.7 — Upload réel de photos de preuve
app.post("/api/requests/:id/evidence/upload", auth, evidenceUpload.single('photo'), (req,res) => {
  if (!req.file) return res.status(400).json({error:"Photo manquante"});
  const request = db.prepare("SELECT * FROM requests WHERE id=?").get(req.params.id);
  if (!request) {
    try { fs.unlinkSync(req.file.path); } catch(e){}
    return res.status(404).json({error:"Demande introuvable"});
  }
  if (request.user_id !== req.user.id && req.user.role !== 'professional' && req.user.role !== 'admin') {
    try { fs.unlinkSync(req.file.path); } catch(e){}
    return res.status(403).json({error:"Accès refusé"});
  }
  const type = String(req.body.type || 'PROOF').toUpperCase();
  if (!['BEFORE','ARRIVAL','PROOF','AFTER'].includes(type)) {
    try { fs.unlinkSync(req.file.path); } catch(e){}
    return res.status(400).json({error:"Type de preuve invalide"});
  }
  const url = '/uploads/evidence/' + req.file.filename;
  const comment = String(req.body.comment || '').slice(0,500);
  const info = db.prepare(`INSERT INTO intervention_evidence
    (request_id,actor_user_id,evidence_type,photo_url,note,created_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(request.id,req.user.id,type,url,comment);
  res.json({success:true,id:info.lastInsertRowid,type,url,comment});
});

// KÔKÔ V0.8 — Couche paiement (provider-neutral + mode simulation)
// Aucun fonds réel ne transite par ce prototype.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    payer_user_id INTEGER NOT NULL,
    professional_user_id INTEGER,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'XOF',
    provider TEXT DEFAULT 'SIMULATOR',
    method TEXT,
    status TEXT DEFAULT 'PENDING',
    provider_reference TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
} catch(e) { console.error("Payment migration:", e.message); }

app.post("/api/payments/create", auth, (req,res) => {
  const requestId = Number(req.body.request_id);
  const amount = Number(req.body.amount);
  const method = String(req.body.method || 'SIMULATOR').toUpperCase();
  const allowed = ['SIMULATOR','ORANGE_MONEY_CI','MTN_CI','MOOV_CI','WAVE_CI','DJAMO_CI','CARD'];
  if (!requestId || !Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({error:"Demande et montant valides requis"});
  if (!allowed.includes(method)) return res.status(400).json({error:"Moyen de paiement non pris en charge"});
  const request = db.prepare("SELECT * FROM requests WHERE id=?").get(requestId);
  if (!request) return res.status(404).json({error:"Demande introuvable"});
  if (request.user_id !== req.user.id) return res.status(403).json({error:"Seul le client peut initier le paiement"});
  const ref = 'KOKO-' + Date.now() + '-' + Math.random().toString(36).slice(2,7).toUpperCase();
  const result = db.prepare(`INSERT INTO payments(request_id,payer_user_id,amount,currency,provider,method,status,provider_reference)
    VALUES(?,?,?,?,?,?,?,?)`).run(requestId,req.user.id,Math.round(amount),'XOF','SIMULATOR',method,'PENDING',ref);
  res.json({success:true,payment_id:result.lastInsertRowid,status:'PENDING',reference:ref,
    message:'Paiement créé en mode simulation. Aucun argent réel n’a été débité.'});
});

app.get("/api/payments/:id", auth, (req,res) => {
  const p = db.prepare("SELECT * FROM payments WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({error:"Paiement introuvable"});
  if (p.payer_user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({error:"Accès refusé"});
  res.json(p);
});

app.post("/api/payments/:id/simulate-success", auth, (req,res) => {
  const p = db.prepare("SELECT * FROM payments WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({error:"Paiement introuvable"});
  if (p.payer_user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({error:"Accès refusé"});
  db.prepare("UPDATE payments SET status='PAID',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  const request = db.prepare("SELECT * FROM requests WHERE id=?").get(p.request_id);
  if (request && typeof addNotification === 'function') {
    addNotification(req.user.id,'PAYMENT_CONFIRMED','Paiement confirmé',`Paiement KÔKÔ de ${p.amount} XOF confirmé.`,p.request_id);
  }
  res.json({success:true,status:'PAID'});
});

app.post("/api/payments/:id/cancel", auth, (req,res) => {
  const p = db.prepare("SELECT * FROM payments WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({error:"Paiement introuvable"});
  if (p.payer_user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({error:"Accès refusé"});
  db.prepare("UPDATE payments SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  res.json({success:true,status:'CANCELLED'});
});

// Point d’entrée futur d’un prestataire réel.
// Il devra vérifier la signature/IPN du prestataire avant de marquer PAID.
app.post("/api/payments/webhook/provider", (req,res) => {
  res.status(501).json({error:"Connecteur fournisseur réel non activé dans le prototype"});
});


// Create an intervention from an accepted quote.
app.post('/api/interventions', auth, (req,res)=>{
  try{
    const {request_id, quote_id, scheduled_date, scheduled_time, address, client_note}=req.body||{};
    const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(Number(request_id));
    if(!request) return res.status(404).json({error:'Demande introuvable'});
    if(request.client_id!==req.user.id) return res.status(403).json({error:'Seul le client peut planifier l’intervention'});

    const quote=db.prepare(`SELECT q.*, p.id professional_id, p.user_id professional_user_id
      FROM quotes q JOIN professionals p ON p.id=q.professional_id
      WHERE q.id=? AND q.request_id=?`).get(Number(quote_id),Number(request_id));
    if(!quote) return res.status(404).json({error:'Devis introuvable'});
    if(quote.status!=='ACCEPTED') return res.status(400).json({error:'Le devis doit être accepté avant planification'});

    const existing=db.prepare(`SELECT id FROM interventions WHERE request_id=?`).get(Number(request_id));
    if(existing) return res.status(409).json({error:'Une intervention existe déjà pour cette demande', intervention_id:existing.id});

    const result=db.prepare(`INSERT INTO interventions
      (request_id,quote_id,professional_id,client_id,scheduled_date,scheduled_time,address,client_note,status)
      VALUES (?,?,?,?,?,?,?,?, 'SCHEDULED')`)
      .run(Number(request_id),Number(quote_id),quote.professional_id,req.user.id,scheduled_date||null,scheduled_time||null,address||null,client_note||null);

    db.prepare(`UPDATE requests SET status='SCHEDULED' WHERE id=?`).run(Number(request_id));
    db.prepare(`INSERT INTO intervention_events (intervention_id,event_type,actor_user_id,note) VALUES (?,?,?,?)`)
      .run(result.lastInsertRowid,'SCHEDULED',req.user.id,'Intervention planifiée');
    res.status(201).json({id:result.lastInsertRowid,status:'SCHEDULED'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/interventions/:id', auth, (req,res)=>{
  try{
    const i=db.prepare(`SELECT i.*, p.company_name, u.name professional_name
      FROM interventions i
      JOIN professionals p ON p.id=i.professional_id
      JOIN users u ON u.id=p.user_id
      WHERE i.id=?`).get(Number(req.params.id));
    if(!i) return res.status(404).json({error:'Intervention introuvable'});
    if(i.client_id!==req.user.id && i.professional_id!==db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id)?.id)
      return res.status(403).json({error:'Accès refusé'});
    const events=db.prepare(`SELECT * FROM intervention_events WHERE intervention_id=? ORDER BY id ASC`).all(i.id);
    res.json({intervention:i,events});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/interventions/:id/status', auth, (req,res)=>{
  try{
    const id=Number(req.params.id), next=String(req.body?.status||'').toUpperCase();
    const allowed=['ON_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED'];
    if(!allowed.includes(next)) return res.status(400).json({error:'Statut invalide'});
    const i=db.prepare(`SELECT * FROM interventions WHERE id=?`).get(id);
    if(!i) return res.status(404).json({error:'Intervention introuvable'});
    const pro=db.prepare(`SELECT id,user_id FROM professionals WHERE id=?`).get(i.professional_id);
    if(!pro || pro.user_id!==req.user.id) return res.status(403).json({error:'Seul le professionnel concerné peut changer ce statut'});

    const now=new Date().toISOString();
    let sql=`UPDATE interventions SET status=?,updated_at=?`;
    const params=[next,now];
    if(next==='ARRIVED'){sql+=`,arrived_at=?`;params.push(now);}
    if(next==='IN_PROGRESS'){sql+=`,started_at=?`;params.push(now);}
    if(next==='COMPLETED'){sql+=`,completed_at=?`;params.push(now);}
    sql+=` WHERE id=?`;params.push(id);
    db.prepare(sql).run(...params);

    db.prepare(`UPDATE requests SET status=? WHERE id=?`).run(next,id && i.request_id);
    db.prepare(`INSERT INTO intervention_events (intervention_id,event_type,actor_user_id,note) VALUES (?,?,?,?)`)
      .run(id,next,req.user.id,null);
    
    const statusLabels={ON_ROUTE:'en route',ARRIVED:'arrivé sur place',IN_PROGRESS:'a démarré les travaux',COMPLETED:'a terminé les travaux'};
    if(statusLabels[next]) createKokoNotification(i.client_id,'INTERVENTION_STATUS','Mise à jour de l’intervention','Le professionnel '+statusLabels[next]+'.',{request_id:i.request_id,intervention_id:id});
res.json({ok:true,status:next});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/interventions/:id/confirm', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const i=db.prepare(`SELECT * FROM interventions WHERE id=?`).get(id);
    if(!i) return res.status(404).json({error:'Intervention introuvable'});
    if(i.client_id!==req.user.id) return res.status(403).json({error:'Seul le client peut confirmer'});
    if(i.status!=='COMPLETED') return res.status(400).json({error:'L’intervention doit être marquée terminée avant confirmation'});
    const now=new Date().toISOString();
    db.prepare(`UPDATE interventions SET status='AWAITING_CONFIRMATION',client_confirmed_at=NULL,updated_at=? WHERE id=?`).run(now,id);
    db.prepare(`INSERT INTO intervention_events (intervention_id,event_type,actor_user_id,note) VALUES (?,?,?,?)`)
      .run(id,'AWAITING_CONFIRMATION',req.user.id,req.body?.note||null);
    res.json({ok:true,status:'AWAITING_CONFIRMATION'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/interventions/:id/validate', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const i=db.prepare(`SELECT * FROM interventions WHERE id=?`).get(id);
    if(!i) return res.status(404).json({error:'Intervention introuvable'});
    if(i.client_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
    if(!['COMPLETED','AWAITING_CONFIRMATION'].includes(i.status)) return res.status(400).json({error:'Intervention non terminée'});
    const now=new Date().toISOString();
    db.prepare(`UPDATE interventions SET status='VALIDATED',client_confirmed_at=?,updated_at=? WHERE id=?`).run(now,now,id);
    db.prepare(`UPDATE requests SET status='COMPLETED' WHERE id=?`).run(i.request_id);
    db.prepare(`INSERT INTO intervention_events (intervention_id,event_type,actor_user_id,note) VALUES (?,?,?,?)`)
      .run(id,'VALIDATED',req.user.id,req.body?.note||'Travail validé par le client');
    res.json({ok:true,status:'VALIDATED'});
  }catch(e){res.status(500).json({error:e.message});}
});



function distanceKm(lat1, lon1, lat2, lon2){
  const R=6371;
  const toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

app.post('/api/me/location', auth, (req,res)=>{
  try{
    const lat=Number(req.body?.latitude), lon=Number(req.body?.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)
      return res.status(400).json({error:'Coordonnées GPS invalides'});
    db.prepare(`UPDATE users SET latitude=?,longitude=? WHERE id=?`).run(lat,lon,req.user.id);
    res.json({ok:true,latitude:lat,longitude:lon});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/pro/location', auth, (req,res)=>{
  try{
    const lat=Number(req.body?.latitude), lon=Number(req.body?.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)
      return res.status(400).json({error:'Coordonnées GPS invalides'});
    const p=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id);
    if(!p) return res.status(404).json({error:'Profil professionnel introuvable'});
    db.prepare(`UPDATE professionals SET latitude=?,longitude=? WHERE id=?`).run(lat,lon,p.id);
    res.json({ok:true,latitude:lat,longitude:lon});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/professionals/nearby', auth, (req,res)=>{
  try{
    const lat=Number(req.query.latitude), lon=Number(req.query.longitude);
    const radius=Math.min(Math.max(Number(req.query.radius_km||15),1),100);
    const category=req.query.category?String(req.query.category):null;
    if(!Number.isFinite(lat)||!Number.isFinite(lon))
      return res.status(400).json({error:'latitude et longitude sont requises'});

    let sql=`SELECT p.*,u.name professional_name FROM professionals p JOIN users u ON u.id=p.user_id
             WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL`;
    const params=[];
    if(category){sql+=` AND lower(p.category)=lower(?)`;params.push(category);}
    const rows=db.prepare(sql).all(...params);

    const result=rows.map(p=>{
      const distance=distanceKm(lat,lon,p.latitude,p.longitude);
      return {...p,distance_km:Number(distance.toFixed(2))};
    }).filter(p=>p.distance_km<=radius)
      .sort((a,b)=>a.distance_km-b.distance_km);

    res.json({center:{latitude:lat,longitude:lon},radius_km:radius,professionals:result});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/pro/radius', auth, (req,res)=>{
  try{
    const radius=Math.min(Math.max(Number(req.body?.service_radius_km||15),1),100);
    const p=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id);
    if(!p) return res.status(404).json({error:'Profil professionnel introuvable'});
    db.prepare(`UPDATE professionals SET service_radius_km=? WHERE id=?`).run(radius,p.id);
    res.json({ok:true,service_radius_km:radius});
  }catch(e){res.status(500).json({error:e.message});}
});



// Get or create a conversation for a request and professional.
app.post('/api/conversations', auth, (req,res)=>{
  try{
    const requestId=Number(req.body?.request_id);
    const professionalId=Number(req.body?.professional_id);
    const r=db.prepare(`SELECT * FROM requests WHERE id=?`).get(requestId);
    if(!r) return res.status(404).json({error:'Demande introuvable'});
    const p=db.prepare(`SELECT * FROM professionals WHERE id=?`).get(professionalId);
    if(!p) return res.status(404).json({error:'Professionnel introuvable'});
    const isClient=r.client_id===req.user.id;
    const isPro=p.user_id===req.user.id;
    if(!isClient && !isPro) return res.status(403).json({error:'Accès refusé'});

    let c=db.prepare(`SELECT * FROM conversations WHERE request_id=? AND professional_id=?`)
      .get(requestId,professionalId);
    if(!c){
      const result=db.prepare(`INSERT INTO conversations(request_id,client_id,professional_id) VALUES(?,?,?)`)
        .run(requestId,r.client_id,professionalId);
      c=db.prepare(`SELECT * FROM conversations WHERE id=?`).get(result.lastInsertRowid);
    }
    res.status(201).json(c);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/conversations', auth, (req,res)=>{
  try{
    const pro=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id);
    const rows=pro ? db.prepare(`
      SELECT c.*,p.company_name,u.name client_name
      FROM conversations c
      JOIN professionals p ON p.id=c.professional_id
      JOIN users u ON u.id=c.client_id
      WHERE c.client_id=? OR p.user_id=?
      ORDER BY c.updated_at DESC
    `).all(req.user.id,req.user.id) : db.prepare(`
      SELECT c.*,p.company_name,u.name professional_name
      FROM conversations c
      JOIN professionals p ON p.id=c.professional_id
      JOIN users u ON u.id=p.user_id
      WHERE c.client_id=?
      ORDER BY c.updated_at DESC
    `).all(req.user.id);
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/conversations/:id/messages', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const c=db.prepare(`SELECT c.*,p.user_id professional_user_id FROM conversations c
      JOIN professionals p ON p.id=c.professional_id WHERE c.id=?`).get(id);
    if(!c) return res.status(404).json({error:'Conversation introuvable'});
    if(c.client_id!==req.user.id && c.professional_user_id!==req.user.id)
      return res.status(403).json({error:'Accès refusé'});
    const messages=db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC`).all(id);
    db.prepare(`UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND sender_user_id<>? AND read_at IS NULL`)
      .run(id,req.user.id);
    res.json(messages);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/conversations/:id/messages', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const c=db.prepare(`SELECT c.*,p.user_id professional_user_id FROM conversations c
      JOIN professionals p ON p.id=c.professional_id WHERE c.id=?`).get(id);
    if(!c) return res.status(404).json({error:'Conversation introuvable'});
    if(c.client_id!==req.user.id && c.professional_user_id!==req.user.id)
      return res.status(403).json({error:'Accès refusé'});
    const body=String(req.body?.body||'').trim();
    const attachmentUrl=req.body?.attachment_url?String(req.body.attachment_url):null;
    const attachmentName=req.body?.attachment_name?String(req.body.attachment_name):null;
    if(!body && !attachmentUrl) return res.status(400).json({error:'Message vide'});
    if(body.length>4000) return res.status(400).json({error:'Message trop long'});
    const type=attachmentUrl ? (body?'TEXT_IMAGE':'IMAGE') : 'TEXT';
    const result=db.prepare(`INSERT INTO messages(conversation_id,sender_user_id,message_type,body,attachment_url,attachment_name)
      VALUES(?,?,?,?,?,?)`).run(id,req.user.id,type,body||null,attachmentUrl,attachmentName);
    db.prepare(`UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    
    const recipientUserId = c.client_id===req.user.id ? c.professional_user_id : c.client_id;
    createKokoNotification(recipientUserId,'NEW_MESSAGE','Nouveau message','Vous avez reçu un nouveau message dans KÔKÔ.',{request_id:c.request_id,conversation_id:id});
res.status(201).json(db.prepare(`SELECT * FROM messages WHERE id=?`).get(result.lastInsertRowid));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/conversations/:id/read', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const c=db.prepare(`SELECT c.*,p.user_id professional_user_id FROM conversations c
      JOIN professionals p ON p.id=c.professional_id WHERE c.id=?`).get(id);
    if(!c) return res.status(404).json({error:'Conversation introuvable'});
    if(c.client_id!==req.user.id && c.professional_user_id!==req.user.id)
      return res.status(403).json({error:'Accès refusé'});
    db.prepare(`UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND sender_user_id<>?`).run(id,req.user.id);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});



app.get('/api/notifications', auth, (req,res)=>{
  try{
    const limit=Math.min(Math.max(Number(req.query.limit||50),1),100);
    const rows=db.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?`)
      .all(req.user.id,limit);
    const unread=db.prepare(`SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL`)
      .get(req.user.id).n;
    res.json({notifications:rows,unread:Number(unread)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/notifications/:id/read', auth, (req,res)=>{
  try{
    const id=Number(req.params.id);
    const n=db.prepare(`SELECT * FROM notifications WHERE id=?`).get(id);
    if(!n) return res.status(404).json({error:'Notification introuvable'});
    if(n.user_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
    db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/notifications/read-all', auth, (req,res)=>{
  try{
    db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL`).run(req.user.id);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Manual event notification endpoint for trusted internal/admin flows.
app.post('/api/notifications/event', auth, (req,res)=>{
  try{
    const {user_id,type,title,body,request_id,intervention_id,conversation_id}=req.body||{};
    if(Number(user_id)!==req.user.id) return res.status(403).json({error:'Accès refusé'});
    if(!type||!title||!body) return res.status(400).json({error:'Notification incomplète'});
    createKokoNotification(req.user.id,String(type),String(title),String(body),{request_id,intervention_id,conversation_id});
    res.status(201).json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});



// ==================== KÔKÔ V1.4 — ESPACE KÔKÔ PRO ====================

function proUser(req, res, next) {
  if (!req.user || !['professional','PROFESSIONAL','pro','PRO'].includes(String(req.user.role))) {
    return res.status(403).json({error:'Accès réservé à KÔKÔ PRO'});
  }
  next();
}

app.get('/api/pro/dashboard', auth, proUser, (req,res) => {
  const uid = req.user.id;
  const pro = db.prepare('SELECT * FROM professionals WHERE user_id=?').get(uid);
  if (!pro) return res.status(404).json({error:'Profil professionnel introuvable'});

  const pendingQuotes = db.prepare(`
    SELECT COUNT(*) c FROM quotes q
    WHERE q.professional_id=? AND q.status='PENDING'
  `).get(pro.id).c;

  const acceptedQuotes = db.prepare(`
    SELECT COUNT(*) c FROM quotes q
    WHERE q.professional_id=? AND q.status='ACCEPTED'
  `).get(pro.id).c;

  const interventions = db.prepare(`
    SELECT COUNT(*) c FROM interventions i
    WHERE i.professional_id=? AND i.status NOT IN ('COMPLETED','CANCELLED')
  `).get(pro.id).c;

  const completed = db.prepare(`
    SELECT COUNT(*) c FROM interventions i
    WHERE i.professional_id=? AND i.status='COMPLETED'
  `).get(pro.id).c;

  const unreadMessages = db.prepare(`
    SELECT COUNT(*) c FROM messages m
    JOIN conversations c ON c.id=m.conversation_id
    WHERE c.professional_id=? AND m.sender_user_id != ? AND m.read_at IS NULL
  `).get(pro.id, uid).c;

  const unreadNotifications = db.prepare(`
    SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL
  `).get(uid).c;

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(amount),0) total
    FROM payments
    WHERE professional_user_id=? AND status='SUCCESS'
  `).get(uid).total || 0;

  const rating = db.prepare(`
    SELECT COALESCE(AVG(r.rating),0) avg_rating, COUNT(r.id) review_count
    FROM reviews r
    JOIN professionals p ON p.id=r.professional_id
    WHERE p.id=?
  `).get(pro.id);

  const recent = db.prepare(`
    SELECT q.id, q.amount, q.status, q.created_at,
           r.id request_id, r.title, r.category, r.zone
    FROM quotes q JOIN requests r ON r.id=q.request_id
    WHERE q.professional_id=?
    ORDER BY q.created_at DESC LIMIT 8
  `).all(pro.id);

  res.json({
    professional: pro,
    kpis: {
      pendingQuotes, acceptedQuotes, activeInterventions: interventions,
      completedInterventions: completed, unreadMessages, unreadNotifications,
      revenueXof: Number(revenue), rating: Number(rating.avg_rating || 0),
      reviewCount: Number(rating.review_count || 0)
    },
    recent
  });
});

app.get('/api/pro/requests', auth, proUser, (req,res) => {
  const uid=req.user.id;
  const pro=db.prepare('SELECT * FROM professionals WHERE user_id=?').get(uid);
  if(!pro) return res.status(404).json({error:'Profil professionnel introuvable'});
  const category=(req.query.category||'').trim();
  const zone=(req.query.zone||'').trim();
  const params=[pro.id];
  let where=`r.status NOT IN ('CLOSED','COMPLETED','CANCELLED')
             AND r.id NOT IN (SELECT request_id FROM quotes WHERE professional_id=?)`;
  if(category){ where += ` AND lower(r.category)=lower(?)`; params.push(category); }
  if(zone){ where += ` AND lower(r.zone) LIKE lower(?)`; params.push('%'+zone+'%'); }
  const rows=db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM quotes q WHERE q.request_id=r.id) quote_count
    FROM requests r
    WHERE ${where}
    ORDER BY r.created_at DESC LIMIT 50
  `).all(...params);
  res.json(rows);
});

app.get('/api/pro/calendar', auth, proUser, (req,res) => {
  const uid=req.user.id;
  const pro=db.prepare('SELECT * FROM professionals WHERE user_id=?').get(uid);
  if(!pro) return res.status(404).json({error:'Profil professionnel introuvable'});
  const rows=db.prepare(`
    SELECT i.*, r.title, r.category, r.zone, r.description,
           u.name client_name
    FROM interventions i
    JOIN requests r ON r.id=i.request_id
    JOIN users u ON u.id=r.user_id
    WHERE i.professional_id=?
    ORDER BY COALESCE(i.scheduled_at,i.created_at) ASC
    LIMIT 100
  `).all(pro.id);
  res.json(rows);
});

app.get('/api/pro/revenue', auth, proUser, (req,res) => {
  const uid=req.user.id;
  const rows=db.prepare(`
    SELECT status, currency, COUNT(*) count, COALESCE(SUM(amount),0) total
    FROM payments
    WHERE professional_user_id=?
    GROUP BY status, currency
  `).all(uid);
  const monthly=db.prepare(`
    SELECT substr(created_at,1,7) month, COALESCE(SUM(amount),0) total, COUNT(*) count
    FROM payments
    WHERE professional_user_id=? AND status='SUCCESS'
    GROUP BY substr(created_at,1,7)
    ORDER BY month DESC LIMIT 12
  `).all(uid);
  res.json({summary:rows, monthly});
});

app.get('/api/pro/reputation', auth, proUser, (req,res) => {
  const uid=req.user.id;
  const pro=db.prepare('SELECT * FROM professionals WHERE user_id=?').get(uid);
  if(!pro) return res.status(404).json({error:'Profil professionnel introuvable'});
  const stats=db.prepare(`
    SELECT COALESCE(AVG(rating),0) avg_rating, COUNT(*) count
    FROM reviews WHERE professional_id=?
  `).get(pro.id);
  const distribution=db.prepare(`
    SELECT rating, COUNT(*) count FROM reviews
    WHERE professional_id=? GROUP BY rating ORDER BY rating DESC
  `).all(pro.id);
  const reviews=db.prepare(`
    SELECT r.rating,r.comment,r.created_at,u.name client_name
    FROM reviews r JOIN users u ON u.id=r.client_id
    WHERE r.professional_id=? ORDER BY r.created_at DESC LIMIT 20
  `).all(pro.id);
  res.json({stats,distribution,reviews});
});


// ==================== KÔKÔ V1.5 — ADMINISTRATION & CONTRÔLE ====================
function adminOnly(req,res,next){
  if(!req.user || !['admin','ADMIN'].includes(String(req.user.role))) return res.status(403).json({error:'Accès administrateur requis'});
  next();
}
app.get('/api/admin/dashboard', auth, adminOnly, (req,res)=>{
  const users=db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const pros=db.prepare(`SELECT COUNT(*) c FROM professionals`).get().c;
  const verified=db.prepare(`SELECT COUNT(*) c FROM professionals WHERE verified=1`).get().c;
  const pendingDocs=db.prepare(`SELECT COUNT(*) c FROM professional_documents WHERE status='PENDING'`).get().c;
  const requests=db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  const activeRequests=db.prepare(`SELECT COUNT(*) c FROM requests WHERE status NOT IN ('CLOSED','COMPLETED','CANCELLED')`).get().c;
  const interventions=db.prepare(`SELECT COUNT(*) c FROM interventions`).get().c;
  const disputes=db.prepare(`SELECT COUNT(*) c FROM requests WHERE status='DISPUTE'`).get().c;
  const payments=db.prepare(`SELECT COUNT(*) c FROM payments WHERE status IN ('SUCCESS','PAID')`).get().c;
  const volume=db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM payments WHERE status IN ('SUCCESS','PAID')`).get().total||0;
  const unread=db.prepare(`SELECT COUNT(*) c FROM notifications WHERE read_at IS NULL`).get().c;
  res.json({kpis:{users,pros,verified,pendingDocs,requests,activeRequests,interventions,disputes,successfulPayments:payments,volumeXof:Number(volume),unreadNotifications:unread}});
});
app.get('/api/admin/professionals', auth, adminOnly, (req,res)=>{
  const rows=db.prepare(`
    SELECT p.*, u.name user_name, u.email user_email,
      (SELECT COUNT(*) FROM professional_documents d WHERE d.professional_id=p.id AND d.status='PENDING') pending_documents,
      (SELECT COUNT(*) FROM professional_documents d WHERE d.professional_id=p.id AND d.status='APPROVED') approved_documents,
      (SELECT COALESCE(AVG(r.rating),0) FROM reviews r WHERE r.professional_id=p.id) rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.professional_id=p.id) review_count
    FROM professionals p JOIN users u ON u.id=p.user_id
    ORDER BY p.verified DESC, p.created_at DESC
  `).all();
  res.json(rows);
});
app.get('/api/admin/documents', auth, adminOnly, (req,res)=>{
  const rows=db.prepare(`
    SELECT d.*, p.business_name professional_name, u.email professional_email
    FROM professional_documents d
    JOIN professionals p ON p.id=d.professional_id
    JOIN users u ON u.id=p.user_id
    ORDER BY CASE WHEN d.status='PENDING' THEN 0 ELSE 1 END, d.created_at DESC
  `).all();
  res.json(rows);
});
app.post('/api/admin/documents/:id/review', auth, adminOnly, (req,res)=>{
  const {status,reason=''}=req.body||{};
  if(!['PENDING','APPROVED','REJECTED'].includes(status)) return res.status(400).json({error:'Statut invalide'});
  const doc=db.prepare(`SELECT * FROM professional_documents WHERE id=?`).get(req.params.id);
  if(!doc) return res.status(404).json({error:'Document introuvable'});
  db.prepare(`UPDATE professional_documents SET status=?, review_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(status,reason,req.params.id);
  res.json({ok:true});
});
app.post('/api/admin/professionals/:id/verify', auth, adminOnly, (req,res)=>{
  const {verified=true}=req.body||{};
  const p=db.prepare(`SELECT * FROM professionals WHERE id=?`).get(req.params.id);
  if(!p) return res.status(404).json({error:'Professionnel introuvable'});
  db.prepare(`UPDATE professionals SET verified=? WHERE id=?`).run(verified?1:0,p.id);
  res.json({ok:true,verified:!!verified});
});
app.get('/api/admin/disputes', auth, adminOnly, (req,res)=>{
  const rows=db.prepare(`
    SELECT r.*, u.name client_name, u.email client_email,
      (SELECT COUNT(*) FROM intervention_evidence e WHERE e.request_id=r.id) evidence_count,
      (SELECT COUNT(*) FROM payments p WHERE p.request_id=r.id AND p.status IN ('SUCCESS','PAID')) successful_payments
    FROM requests r JOIN users u ON u.id=r.client_id
    WHERE r.status='DISPUTE' ORDER BY r.created_at DESC
  `).all();
  res.json(rows);
});
app.get('/api/admin/finance', auth, adminOnly, (req,res)=>{
  const byStatus=db.prepare(`SELECT status,currency,COUNT(*) count,COALESCE(SUM(amount),0) total FROM payments GROUP BY status,currency ORDER BY status`).all();
  const monthly=db.prepare(`SELECT substr(created_at,1,7) month,COUNT(*) count,COALESCE(SUM(amount),0) total FROM payments WHERE status IN ('SUCCESS','PAID') GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 12`).all();
  res.json({byStatus,monthly});
});
app.get('/api/admin/activity', auth, adminOnly, (req,res)=>{
  const requests=db.prepare(`SELECT id,title,category,zone,status,created_at FROM requests ORDER BY created_at DESC LIMIT 15`).all();
  const payments=db.prepare(`SELECT id,request_id,amount,currency,status,created_at FROM payments ORDER BY created_at DESC LIMIT 15`).all();
  res.json({requests,payments});
});


// ==================== KÔKÔ V1.6 — LITIGES & SÉCURITÉ ====================
db.exec(`
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  opened_by_user_id INTEGER NOT NULL,
  professional_id INTEGER,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  resolved_by_user_id INTEGER,
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL,
  submitted_by_user_id INTEGER NOT NULL,
  evidence_type TEXT NOT NULL DEFAULT 'NOTE',
  content TEXT,
  file_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

function audit(req, action, entityType, entityId, metadata={}) {
  try {
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata,ip_address)
      VALUES(?,?,?,?,?,?)`).run(
      req.user?.id || null, action, entityType || null, entityId || null,
      JSON.stringify(metadata), req.ip || null
    );
  } catch(e) {}
}

function canAccessRequest(reqId, userId) {
  const r=db.prepare(`
    SELECT r.*, p.user_id professional_user_id
    FROM requests r
    LEFT JOIN quotes q ON q.request_id=r.id AND q.status='ACCEPTED'
    LEFT JOIN professionals p ON p.id=q.professional_id
    WHERE r.id=?
  `).get(reqId);
  return r && (r.user_id===userId || r.professional_user_id===userId);
}

// Client/pro : ouvrir un litige
app.post('/api/disputes', auth, (req,res)=>{
  const {request_id, reason, description=''}=req.body||{};
  if(!request_id || !reason) return res.status(400).json({error:'request_id et reason sont requis'});
  if(!canAccessRequest(Number(request_id),req.user.id)) return res.status(403).json({error:'Accès refusé'});
  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(request_id);
  if(!request) return res.status(404).json({error:'Demande introuvable'});
  const existing=db.prepare(`SELECT id FROM disputes WHERE request_id=? AND status IN ('OPEN','UNDER_REVIEW')`).get(request_id);
  if(existing) return res.status(409).json({error:'Un litige est déjà ouvert',dispute_id:existing.id});
  const q=db.prepare(`SELECT p.id FROM quotes q JOIN professionals p ON p.id=q.professional_id WHERE q.request_id=? AND q.status='ACCEPTED'`).get(request_id);
  const info=db.prepare(`
    INSERT INTO disputes(request_id,opened_by_user_id,professional_id,reason,description,status)
    VALUES(?,?,?,?,?,'OPEN')
  `).run(request_id,req.user.id,q?.id||null,reason,description);
  db.prepare(`UPDATE requests SET status='DISPUTE' WHERE id=?`).run(request_id);
  audit(req,'DISPUTE_OPENED','DISPUTE',info.lastInsertRowid,{request_id,reason});
  res.status(201).json({id:info.lastInsertRowid,status:'OPEN'});
});

// Détail d'un litige
app.get('/api/disputes/:id', auth, (req,res)=>{
  const d=db.prepare(`
    SELECT d.*, u.name opened_by_name, u.email opened_by_email
    FROM disputes d JOIN users u ON u.id=d.opened_by_user_id
    WHERE d.id=?
  `).get(req.params.id);
  if(!d) return res.status(404).json({error:'Litige introuvable'});
  const allowed=d.opened_by_user_id===req.user.id ||
    (d.professional_id && db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(d.professional_id)?.user_id===req.user.id) ||
    ['admin','ADMIN'].includes(String(req.user.role));
  if(!allowed) return res.status(403).json({error:'Accès refusé'});
  const evidence=db.prepare(`SELECT e.*,u.name submitted_by_name FROM dispute_evidence e JOIN users u ON u.id=e.submitted_by_user_id WHERE e.dispute_id=? ORDER BY e.created_at ASC`).all(d.id);
  res.json({dispute:d,evidence});
});

// Ajouter une preuve textuelle / URL sécurisée à un litige
app.post('/api/disputes/:id/evidence', auth, (req,res)=>{
  const d=db.prepare(`SELECT * FROM disputes WHERE id=?`).get(req.params.id);
  if(!d) return res.status(404).json({error:'Litige introuvable'});
  const allowed=d.opened_by_user_id===req.user.id ||
    (d.professional_id && db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(d.professional_id)?.user_id===req.user.id) ||
    ['admin','ADMIN'].includes(String(req.user.role));
  if(!allowed) return res.status(403).json({error:'Accès refusé'});
  const {evidence_type='NOTE',content='',file_url=''}=req.body||{};
  const info=db.prepare(`INSERT INTO dispute_evidence(dispute_id,submitted_by_user_id,evidence_type,content,file_url) VALUES(?,?,?,?,?)`)
    .run(d.id,req.user.id,evidence_type,content,file_url);
  audit(req,'DISPUTE_EVIDENCE_ADDED','DISPUTE',d.id,{evidence_id:info.lastInsertRowid,evidence_type});
  res.status(201).json({id:info.lastInsertRowid});
});

// Admin : prendre en charge un litige
app.post('/api/admin/disputes/:id/review', auth, adminOnly, (req,res)=>{
  const d=db.prepare(`SELECT * FROM disputes WHERE id=?`).get(req.params.id);
  if(!d) return res.status(404).json({error:'Litige introuvable'});
  db.prepare(`UPDATE disputes SET status='UNDER_REVIEW',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(d.id);
  audit(req,'DISPUTE_REVIEW_STARTED','DISPUTE',d.id,{});
  res.json({ok:true,status:'UNDER_REVIEW'});
});

// Admin : résoudre un litige
app.post('/api/admin/disputes/:id/resolve', auth, adminOnly, (req,res)=>{
  const {resolution,status='RESOLVED'}=req.body||{};
  if(!resolution) return res.status(400).json({error:'Une résolution est requise'});
  if(!['RESOLVED','REJECTED','CLOSED'].includes(status)) return res.status(400).json({error:'Statut invalide'});
  const d=db.prepare(`SELECT * FROM disputes WHERE id=?`).get(req.params.id);
  if(!d) return res.status(404).json({error:'Litige introuvable'});
  db.prepare(`UPDATE disputes SET status=?,resolution=?,resolved_by_user_id=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status,resolution,req.user.id,d.id);
  if(status==='RESOLVED' || status==='REJECTED' || status==='CLOSED'){
    db.prepare(`UPDATE requests SET status='CLOSED' WHERE id=?`).run(d.request_id);
  }
  audit(req,'DISPUTE_RESOLVED','DISPUTE',d.id,{status,resolution});
  res.json({ok:true,status});
});

// Admin : journal d'audit
app.get('/api/admin/audit-logs', auth, adminOnly, (req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit||100),1),500);
  const rows=db.prepare(`
    SELECT a.*, u.name actor_name, u.email actor_email
    FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
    ORDER BY a.created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});


// ==================== KÔKÔ V1.7 — SÉCURITÉ AVANCÉE DES COMPTES ====================

// Tables de sessions, OTP et tentatives
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  identifier TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts INTEGER DEFAULT 0,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  identifier TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

function sha256(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function randomToken(){ return crypto.randomBytes(32).toString('hex'); }
function randomOtp(){ return String(crypto.randomInt(100000,1000000)); }

function securityEvent(req,type,userId=null,identifier=null,metadata={}){
  try{
    db.prepare(`INSERT INTO security_events(user_id,identifier,event_type,ip_address,metadata)
      VALUES(?,?,?,?,?)`).run(userId,identifier,type,req.ip||null,JSON.stringify(metadata));
  }catch(e){}
}

function createSecureSession(req,userId){
  const raw=randomToken();
  const hash=sha256(raw);
  db.prepare(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))`)
    .run(userId,hash);
  securityEvent(req,'LOGIN_SUCCESS',userId,null,{session:true});
  return raw;
}

function revokeSession(req,raw,userId){
  if(!raw)return;
  db.prepare(`UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=? AND user_id=?`).run(sha256(raw),userId);
  securityEvent(req,'LOGOUT',userId,null,{});
}

// Vérifie un OTP actif et limite les essais
function verifyOtp(identifier,purpose,code){
  const row=db.prepare(`
    SELECT * FROM otp_codes
    WHERE identifier=? AND purpose=? AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC LIMIT 1
  `).get(identifier,purpose);
  if(!row) return {ok:false,error:'Code expiré ou introuvable'};
  if(row.attempts>=5) return {ok:false,error:'Trop de tentatives'};
  db.prepare(`UPDATE otp_codes SET attempts=attempts+1 WHERE id=?`).run(row.id);
  if(sha256(code)!==row.code_hash) return {ok:false,error:'Code incorrect'};
  db.prepare(`UPDATE otp_codes SET consumed_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
  return {ok:true,user_id:row.user_id};
}

// Demande OTP (prototype : le code est retourné uniquement pour test)
// En production : envoyer via SMS/email via un fournisseur approprié et ne jamais renvoyer le code dans l'API.
app.post('/api/security/request-otp', (req,res)=>{
  const {identifier,purpose='LOGIN'}=req.body||{};
  if(!identifier) return res.status(400).json({error:'Identifiant requis'});
  if(!['LOGIN','RECOVERY','VERIFY'].includes(purpose)) return res.status(400).json({error:'Purpose invalide'});
  const user=db.prepare(`SELECT id FROM users WHERE lower(email)=lower(?)`).get(identifier.trim());
  const code=randomOtp();
  const hash=sha256(code);
  db.prepare(`UPDATE otp_codes SET consumed_at=CURRENT_TIMESTAMP WHERE identifier=? AND purpose=? AND consumed_at IS NULL`)
    .run(identifier.trim(),purpose);
  db.prepare(`INSERT INTO otp_codes(user_id,identifier,purpose,code_hash,expires_at) VALUES(?,?,?,?,datetime('now','+10 minutes'))`)
    .run(user?.id||null,identifier.trim(),purpose,hash);
  securityEvent(req,'OTP_REQUEST',user?.id||null,identifier.trim(),{purpose});
  res.json({ok:true,expires_in_seconds:600,
    demo_code:process.env.NODE_ENV==='production'?undefined:code});
});

// Vérification OTP et création de session
app.post('/api/security/verify-otp', (req,res)=>{
  const {identifier,purpose='LOGIN',code}=req.body||{};
  if(!identifier||!code)return res.status(400).json({error:'Identifiant et code requis'});
  const result=verifyOtp(identifier.trim(),purpose,String(code).trim());
  if(!result.ok){
    securityEvent(req,'OTP_FAILED',result.user_id||null,identifier.trim(),{purpose});
    return res.status(401).json({error:result.error});
  }
  const token=createSecureSession(req,result.user_id);
  const user=db.prepare(`SELECT id,name,email,role FROM users WHERE id=?`).get(result.user_id);
  res.json({ok:true,token,user});
});

// Déconnexion sécurisée
app.post('/api/security/logout', auth, (req,res)=>{
  const header=req.headers.authorization||'';
  const raw=header.startsWith('Bearer ')?header.slice(7):'';
  revokeSession(req,raw,req.user.id);
  res.json({ok:true});
});

// Sessions actives de l'utilisateur
app.get('/api/security/sessions', auth, (req,res)=>{
  const rows=db.prepare(`
    SELECT id,created_at,expires_at,revoked_at,
      CASE WHEN revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP THEN 'ACTIVE' ELSE 'ENDED' END status
    FROM sessions WHERE user_id=? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// Révoquer une session précise
app.post('/api/security/sessions/:id/revoke', auth, (req,res)=>{
  const row=db.prepare(`SELECT id FROM sessions WHERE id=? AND user_id=?`).get(req.params.id,req.user.id);
  if(!row)return res.status(404).json({error:'Session introuvable'});
  db.prepare(`UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
  securityEvent(req,'SESSION_REVOKED',req.user.id,null,{session_id:row.id});
  res.json({ok:true});
});

// Révoquer toutes les sessions sauf éventuellement la session courante
app.post('/api/security/sessions/revoke-all', auth, (req,res)=>{
  db.prepare(`UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL`).run(req.user.id);
  securityEvent(req,'ALL_SESSIONS_REVOKED',req.user.id,null,{});
  res.json({ok:true});
});

// Événements sécurité pour l'utilisateur
app.get('/api/security/events', auth, (req,res)=>{
  const rows=db.prepare(`
    SELECT event_type,ip_address,metadata,created_at
    FROM security_events WHERE user_id=? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(rows);
});

// Admin : événements sécurité globaux
app.get('/api/admin/security-events', auth, adminOnly, (req,res)=>{
  const rows=db.prepare(`
    SELECT s.*,u.name user_name,u.email user_email
    FROM security_events s LEFT JOIN users u ON u.id=s.user_id
    ORDER BY s.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});


// KOKO_V18_CLIENT_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS client_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  address_text TEXT NOT NULL,
  zone TEXT,
  latitude REAL,
  longitude REAL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_addresses_user ON client_addresses(user_id);

CREATE TABLE IF NOT EXISTS favorite_professionals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, professional_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorite_professionals(user_id);
`);

function requireClient(req, res, next) {
  if (!req.user) return res.status(401).json({error:'Authentification requise'});
  if (req.user.role && !['CLIENT','USER'].includes(String(req.user.role).toUpperCase())) {
    return res.status(403).json({error:'Accès réservé au client'});
  }
  next();
}


// KOKO_V18_CLIENT_ROUTES

// Profil client
app.get('/api/client/profile', auth, requireClient, (req,res)=>{
  const u = db.prepare(`SELECT id,name,email,phone,role,created_at FROM users WHERE id=?`).get(req.user.id);
  if(!u) return res.status(404).json({error:'Utilisateur introuvable'});
  const addressCount = db.prepare(`SELECT COUNT(*) c FROM client_addresses WHERE user_id=?`).get(u.id).c;
  const favCount = db.prepare(`SELECT COUNT(*) c FROM favorite_professionals WHERE user_id=?`).get(u.id).c;
  res.json({...u, address_count:addressCount, favorite_count:favCount});
});

app.put('/api/client/profile', auth, requireClient, (req,res)=>{
  const name = String(req.body.name||'').trim();
  const phone = String(req.body.phone||'').trim();
  if(!name) return res.status(400).json({error:'Nom requis'});
  db.prepare(`UPDATE users SET name=?, phone=? WHERE id=?`).run(name,phone,req.user.id);
  res.json({ok:true});
});

// Adresses sauvegardées — ne sont jamais publiques
app.get('/api/client/addresses', auth, requireClient, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM client_addresses WHERE user_id=? ORDER BY is_default DESC, created_at DESC`).all(req.user.id);
  res.json(rows);
});

app.post('/api/client/addresses', auth, requireClient, (req,res)=>{
  const label=String(req.body.label||'').trim();
  const address_text=String(req.body.address_text||'').trim();
  const zone=String(req.body.zone||'').trim();
  const latitude=req.body.latitude==null?null:Number(req.body.latitude);
  const longitude=req.body.longitude==null?null:Number(req.body.longitude);
  if(!label || !address_text) return res.status(400).json({error:'Libellé et adresse requis'});
  const makeDefault=!!req.body.is_default;
  const tx=db.transaction(()=>{
    if(makeDefault) db.prepare(`UPDATE client_addresses SET is_default=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(req.user.id);
    const r=db.prepare(`INSERT INTO client_addresses(user_id,label,address_text,zone,latitude,longitude,is_default) VALUES(?,?,?,?,?,?,?)`)
      .run(req.user.id,label,address_text,zone,latitude,longitude,makeDefault?1:0);
    return r.lastInsertRowid;
  });
  const id=tx();
  res.status(201).json(db.prepare(`SELECT * FROM client_addresses WHERE id=?`).get(id));
});

app.put('/api/client/addresses/:id', auth, requireClient, (req,res)=>{
  const id=Number(req.params.id);
  const old=db.prepare(`SELECT * FROM client_addresses WHERE id=? AND user_id=?`).get(id,req.user.id);
  if(!old) return res.status(404).json({error:'Adresse introuvable'});
  const label=String(req.body.label||old.label).trim();
  const address_text=String(req.body.address_text||old.address_text).trim();
  const zone=String(req.body.zone??old.zone??'').trim();
  const latitude=req.body.latitude==null?old.latitude:Number(req.body.latitude);
  const longitude=req.body.longitude==null?old.longitude:Number(req.body.longitude);
  const makeDefault=req.body.is_default==null?!!old.is_default:!!req.body.is_default;
  const tx=db.transaction(()=>{
    if(makeDefault) db.prepare(`UPDATE client_addresses SET is_default=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(req.user.id);
    db.prepare(`UPDATE client_addresses SET label=?,address_text=?,zone=?,latitude=?,longitude=?,is_default=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`)
      .run(label,address_text,zone,latitude,longitude,makeDefault?1:0,id,req.user.id);
  });
  tx();
  res.json(db.prepare(`SELECT * FROM client_addresses WHERE id=?`).get(id));
});

app.delete('/api/client/addresses/:id', auth, requireClient, (req,res)=>{
  const r=db.prepare(`DELETE FROM client_addresses WHERE id=? AND user_id=?`).run(Number(req.params.id),req.user.id);
  res.json({ok:r.changes>0});
});

// Favoris professionnels
app.get('/api/client/favorites', auth, requireClient, (req,res)=>{
  const rows=db.prepare(`
    SELECT fp.id,fp.professional_id,fp.created_at,
           p.id AS p_id,p.name,p.company_name,p.category,p.zone,p.rating,p.verified
    FROM favorite_professionals fp
    JOIN professionals p ON p.id=fp.professional_id
    WHERE fp.user_id=?
    ORDER BY fp.created_at DESC`).all(req.user.id);
  res.json(rows);
});

app.post('/api/client/favorites/:professionalId', auth, requireClient, (req,res)=>{
  const pid=Number(req.params.professionalId);
  const p=db.prepare(`SELECT id FROM professionals WHERE id=?`).get(pid);
  if(!p) return res.status(404).json({error:'Professionnel introuvable'});
  db.prepare(`INSERT OR IGNORE INTO favorite_professionals(user_id,professional_id) VALUES(?,?)`).run(req.user.id,pid);
  res.json({ok:true,favorite:true});
});

app.delete('/api/client/favorites/:professionalId', auth, requireClient, (req,res)=>{
  db.prepare(`DELETE FROM favorite_professionals WHERE user_id=? AND professional_id=?`).run(req.user.id,Number(req.params.professionalId));
  res.json({ok:true,favorite:false});
});

// Historique client
app.get('/api/client/history', auth, requireClient, (req,res)=>{
  const requests=db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM quotes q WHERE q.request_id=r.id) quote_count,
      (SELECT COUNT(*) FROM disputes d WHERE d.request_id=r.id AND d.user_id=?) dispute_count
    FROM requests r
    WHERE r.user_id=?
    ORDER BY r.created_at DESC`).all(req.user.id,req.user.id);
  res.json(requests);
});

// Résumé des dépenses — uniquement paiements SUCCESS liés au client
app.get('/api/client/summary', auth, requireClient, (req,res)=>{
  const total=db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM payments WHERE payer_user_id=? AND status IN ('SUCCESS','PAID')`).get(req.user.id).total||0;
  const count=db.prepare(`SELECT COUNT(*) c FROM payments WHERE payer_user_id=? AND status IN ('SUCCESS','PAID')`).get(req.user.id).c||0;
  const active=db.prepare(`SELECT COUNT(*) c FROM requests WHERE user_id=? AND status NOT IN ('CLOSED','COMPLETED')`).get(req.user.id).c||0;
  const completed=db.prepare(`SELECT COUNT(*) c FROM requests WHERE user_id=? AND status IN ('COMPLETED','CLOSED')`).get(req.user.id).c||0;
  res.json({total_spent:Number(total),successful_payments:Number(count),active_requests:Number(active),completed_requests:Number(completed)});
});

// Centre notifications client
app.get('/api/client/notifications', auth, requireClient, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(req.user.id);
  res.json(rows);
});

// Historique des litiges client
app.get('/api/client/disputes', auth, requireClient, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM disputes WHERE user_id=? ORDER BY created_at DESC`).all(req.user.id);
  res.json(rows);
});

// Reprise rapide : récupérer les pros déjà utilisés sur des demandes terminées
app.get('/api/client/rebook', auth, requireClient, (req,res)=>{
  const rows=db.prepare(`
    SELECT DISTINCT p.id,p.name,p.company_name,p.category,p.zone,p.rating,p.verified
    FROM requests r
    JOIN quotes q ON q.request_id=r.id AND q.status='ACCEPTED'
    JOIN professionals p ON p.id=q.professional_id
    WHERE r.user_id=? AND r.status IN ('COMPLETED','CLOSED')
    ORDER BY r.created_at DESC`).all(req.user.id);
  res.json(rows);
});


// KOKO_V19_MATCHING_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS professional_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professional_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  service_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(professional_id, category, service_name)
);
CREATE INDEX IF NOT EXISTS idx_prof_services_category ON professional_services(category);

CREATE TABLE IF NOT EXISTS matching_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  score REAL NOT NULL,
  reasons TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_matching_request ON matching_events(request_id);
`);


// KOKO_V19_MATCHING_ROUTES

const KOKO_MATCH_CATEGORIES = [
  'Plomberie','Électricité','Climatisation','Étanchéité','Peinture',
  'Carrelage','Maçonnerie','Menuiserie Aluminium','Autre'
];

function kokoNormalize(v){
  return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}

function kokoMatchScore(reqData, p){
  let score=0, reasons=[];
  const rc=kokoNormalize(reqData.category), pc=kokoNormalize(p.category);
  const rz=kokoNormalize(reqData.zone), pz=kokoNormalize(p.zone);

  if(rc && pc && (rc===pc || pc.includes(rc) || rc.includes(pc))){
    score += 45; reasons.push('catégorie correspondante');
  } else if(rc) score += 5;

  if(rz && pz && (rz===pz || pz.includes(rz) || rz.includes(pz))){
    score += 25; reasons.push('zone correspondante');
  }

  if(Number(p.verified)===1) { score += 10; reasons.push('professionnel vérifié'); }
  if(p.rating!=null && Number(p.rating)>0){
    score += Math.min(10, Number(p.rating)*2);
    reasons.push('évaluation disponible');
  }

  const avail=kokoNormalize(p.availability||'');
  if(avail==='available') { score += 8; reasons.push('disponible'); }
  if(avail==='busy') score -= 3;

  return {score:Math.max(0,Math.min(100,score)),reasons};
}

// Services d'un professionnel
app.get('/api/professionals/:id/services', auth, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM professional_services WHERE professional_id=? AND active=1 ORDER BY category,service_name`).all(Number(req.params.id));
  res.json(rows);
});

app.post('/api/professional/services', auth, (req,res)=>{
  const professional=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id);
  if(!professional) return res.status(403).json({error:'Compte professionnel requis'});
  const category=String(req.body.category||'').trim();
  const service_name=String(req.body.service_name||'').trim();
  if(!category) return res.status(400).json({error:'Catégorie requise'});
  const r=db.prepare(`INSERT OR IGNORE INTO professional_services(professional_id,category,service_name) VALUES(?,?,?)`)
    .run(professional.id,category,service_name);
  res.status(201).json(db.prepare(`SELECT * FROM professional_services WHERE id=?`).get(r.lastInsertRowid));
});

// Matching intelligent d'une demande
app.get('/api/requests/:id/matches', auth, async (req,res)=>{
  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(Number(req.params.id));
  if(!request) return res.status(404).json({error:'Demande introuvable'});

  // Client propriétaire, professionnel concerné ou admin
  const isOwner=request.user_id===req.user.id;
  const role=String(req.user.role||'').toUpperCase();
  if(!isOwner && !['ADMIN','PROFESSIONAL','PRO'].includes(role))
    return res.status(403).json({error:'Accès refusé'});

  let pros=db.prepare(`
    SELECT p.*, COALESCE(p.availability,'') availability
    FROM professionals p
    WHERE 1=1
  `).all();

  const results=pros.map(p=>{
    const m=kokoMatchScore(request,p);
    return {...p, match_score:m.score, match_reasons:m.reasons};
  }).filter(x=>x.match_score>15).sort((a,b)=>b.match_score-a.match_score).slice(0,20);

  // Enregistrer les résultats pour audit produit, sans exposer l'algorithme interne au public
  const ins=db.prepare(`INSERT INTO matching_events(request_id,professional_id,score,reasons) VALUES(?,?,?,?)`);
  const tx=db.transaction(rows=>{ for(const x of rows) ins.run(request.id,x.id,x.match_score,JSON.stringify(x.match_reasons)); });
  tx(results);

  res.json({
    request_id:request.id,
    criteria:{
      category:request.category||null,
      zone:request.zone||null
    },
    matches:results.map(x=>({
      professional_id:x.id,
      name:x.name,
      company_name:x.company_name,
      category:x.category,
      zone:x.zone,
      rating:x.rating,
      verified:!!x.verified,
      availability:x.availability,
      match_score:x.match_score,
      reasons:x.match_reasons
    }))
  });
});

// Recommandations globales pour une nouvelle demande avant envoi
app.post('/api/matching/preview', auth, (req,res)=>{
  const category=String(req.body.category||'').trim();
  const zone=String(req.body.zone||'').trim();
  const pros=db.prepare(`SELECT p.*,COALESCE(p.availability,'') availability FROM professionals p`).all();
  const request={category,zone};
  const matches=pros.map(p=>({...p,...kokoMatchScore(request,p)}))
    .filter(x=>x.score>15).sort((a,b)=>b.score-a.score).slice(0,10)
    .map(x=>({professional_id:x.id,name:x.name,company_name:x.company_name,category:x.category,zone:x.zone,rating:x.rating,verified:!!x.verified,availability:x.availability,match_score:x.score,reasons:x.reasons}));
  res.json({criteria:{category,zone},matches});
});

// Suggestions de catégories à partir du texte saisi
app.post('/api/matching/classify', auth, (req,res)=>{
  const text=kokoNormalize(req.body.text);
  const rules=[
    ['Plomberie',['fuite','robinet','tuyau','canalisation','evier','wc','toilette','eau']],
    ['Électricité',['prise','courant','disjoncteur','cable','ampoule','electrique','electricite']],
    ['Climatisation',['clim','climatiseur','climatisation','froid','ventilation']],
    ['Étanchéité',['infiltration','fuite toiture','toiture','etancheite','humidite','terrasse']],
    ['Peinture',['peinture','mur','plafond','repeindre','ravalement']],
    ['Carrelage',['carrelage','carreau','sol','faience']],
    ['Maçonnerie',['mur','dalle','beton','fondation','maçon','maconnerie','construction']],
    ['Menuiserie Aluminium',['fenetre','baie vitree','aluminium','alu','porte']]
  ];
  const scores=rules.map(([cat,words])=>({category:cat,score:words.reduce((n,w)=>n+(text.includes(w)?1:0),0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  res.json({suggestions:scores});
});


// KOKO_V20_AI_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_request_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  category TEXT,
  problem TEXT,
  zone TEXT,
  urgency TEXT,
  timing TEXT,
  budget TEXT,
  details TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id);
`);


// KOKO_V20_AI_ROUTES

const KOKO_AI_RULES = [
  ['Plomberie',['fuite','robinet','tuyau','canalisation','evier','wc','toilette','eau']],
  ['Électricité',['prise','courant','disjoncteur','cable','ampoule','electrique','electricite']],
  ['Climatisation',['clim','climatiseur','climatisation','froid','ventilation']],
  ['Étanchéité',['infiltration','fuite toiture','toiture','etancheite','humide','humidite','terrasse']],
  ['Peinture',['peinture','mur','plafond','repeindre','ravalement']],
  ['Carrelage',['carrelage','carreau','sol','faience']],
  ['Maçonnerie',['mur','dalle','beton','fondation','maconnerie','construction']],
  ['Menuiserie Aluminium',['fenetre','baie vitree','aluminium','alu','porte']]
];

const KOKO_AI_ZONES=['Cocody','Angré','Riviera','Deux-Plateaux','Marcory','Treichville','Plateau','Yopougon','Abobo','Bingerville','Port-Bouët','Koumassi','Adjamé','Anyama'];

function kokoAIExtract(text, current={}){
  const raw=String(text||'');
  const t=kokoNormalize(raw);
  const out={...current};
  const categoryScores=KOKO_AI_RULES.map(([cat,words])=>({
    category:cat,
    score:words.reduce((n,w)=>n+(t.includes(kokoNormalize(w))?1:0),0)
  })).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  if(categoryScores.length) out.category=categoryScores[0].category;

  for(const z of KOKO_AI_ZONES){
    if(t.includes(kokoNormalize(z))) { out.zone=z; break; }
  }

  if(/\b(urgent|urgence|immediat|aujourd|maintenant|vite)\b/.test(t)) out.urgency='URGENT';
  else if(/\b(cette semaine|semaine)\b/.test(t)) out.urgency='THIS_WEEK';
  else if(/\b(cette semaine|demain)\b/.test(t)) out.urgency='SOON';

  const budget=/(\d[\d\s.,]*)(?:\s*)(fcfa|f|francs?)/i.exec(raw);
  if(budget) out.budget=budget[1].replace(/\s/g,'')+' FCFA';

  if(!out.problem && raw.trim().length>=8) out.problem=raw.trim();

  const fields=['category','problem','zone'];
  const present=fields.filter(k=>out[k]&&String(out[k]).trim()).length;
  out.confidence=Math.min(1, present/3 + (out.urgency?0.05:0));
  out.ready=present>=3;
  return out;
}

function kokoAINextQuestion(d){
  if(!d.category) return 'Quel type de problème avez-vous : plomberie, électricité, climatisation, étanchéité, peinture, carrelage, maçonnerie ou autre ?';
  if(!d.problem) return 'Décrivez-moi simplement le problème ou le travail à réaliser.';
  if(!d.zone) return 'Dans quelle zone se trouve l’intervention ? (ex. Angré, Cocody, Riviera…)';
  if(!d.urgency) return 'Quand souhaitez-vous l’intervention : aujourd’hui, cette semaine ou plus tard ?';
  return 'Merci. Votre demande est suffisamment structurée. Voulez-vous rechercher des professionnels et demander des devis ?';
}

function kokoAIAdvice(d){
  if(d.category==='Étanchéité' && d.problem && /infiltration|fuite|humide/i.test(d.problem)){
    return 'KÔKÔ peut vous aider à trouver un professionnel. Une visite sur place peut être nécessaire pour identifier précisément la cause avant les travaux.';
  }
  return 'KÔKÔ structure votre besoin pour faciliter la recherche d’un professionnel. Le diagnostic technique final reste à la charge du professionnel sur place.';
}

app.post('/api/ai/conversations', auth, (req,res)=>{
  const r=db.prepare(`INSERT INTO ai_conversations(user_id) VALUES(?)`).run(req.user.id);
  db.prepare(`INSERT INTO ai_request_drafts(conversation_id) VALUES(?)`).run(r.lastInsertRowid);
  res.status(201).json({conversation_id:r.lastInsertRowid});
});

app.get('/api/ai/conversations/:id', auth, (req,res)=>{
  const c=db.prepare(`SELECT * FROM ai_conversations WHERE id=? AND user_id=?`).get(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Conversation introuvable'});
  const messages=db.prepare(`SELECT id,role,content,created_at FROM ai_messages WHERE conversation_id=? ORDER BY id`).all(c.id);
  const draft=db.prepare(`SELECT * FROM ai_request_drafts WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(c.id);
  res.json({conversation:c,messages,draft});
});

app.post('/api/ai/conversations/:id/message', auth, (req,res)=>{
  const id=Number(req.params.id);
  const c=db.prepare(`SELECT * FROM ai_conversations WHERE id=? AND user_id=?`).get(id,req.user.id);
  if(!c) return res.status(404).json({error:'Conversation introuvable'});
  const content=String(req.body.content||'').trim();
  if(!content) return res.status(400).json({error:'Message vide'});

  db.prepare(`INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)`).run(id,'user',content);
  const old=db.prepare(`SELECT * FROM ai_request_drafts WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(id) || {};
  const draft=kokoAIExtract(content,old);

  const q=kokoAINextQuestion(draft);
  const advice=kokoAIAdvice(draft);
  let reply=q;
  if(draft.ready && draft.urgency) reply=advice+' '+q;

  db.prepare(`UPDATE ai_request_drafts SET category=?,problem=?,zone=?,urgency=?,timing=?,budget=?,details=?,confidence=?,ready=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(draft.category||null,draft.problem||null,draft.zone||null,draft.urgency||null,draft.timing||null,draft.budget||null,draft.details||null,draft.confidence||0,draft.ready?1:0,old.id||db.prepare(`INSERT INTO ai_request_drafts(conversation_id) VALUES(?)`).run(id).lastInsertRowid);

  db.prepare(`INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)`).run(id,'assistant',reply);
  db.prepare(`UPDATE ai_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);

  res.json({reply,draft:{...draft,ready:!!draft.ready},suggested_action:draft.ready?'SEARCH_PROFESSIONALS':'CONTINUE'});
});

app.post('/api/ai/conversations/:id/convert', auth, (req,res)=>{
  const id=Number(req.params.id);
  const c=db.prepare(`SELECT * FROM ai_conversations WHERE id=? AND user_id=?`).get(id,req.user.id);
  if(!c) return res.status(404).json({error:'Conversation introuvable'});
  const d=db.prepare(`SELECT * FROM ai_request_drafts WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(id);
  if(!d || !d.category || !d.problem || !d.zone) return res.status(400).json({error:'La demande doit encore être complétée'});
  const r=db.prepare(`INSERT INTO requests(client_id,category,description,zone,preferred_time,status,user_id,title,problem,service,location,budget) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id,d.category,d.problem,d.zone,null,'OPEN',req.user.id,d.category,d.problem,d.category,d.zone,d.budget?Number(String(d.budget).replace(/[^0-9]/g,''))||null:null);
  db.prepare(`UPDATE ai_conversations SET request_id=?,status='CONVERTED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(r.lastInsertRowid,id);
  res.status(201).json({request_id:r.lastInsertRowid});
});


// KOKO_V21_IA_MATCHING_ROUTES

// Pipeline unifié : assistant IA -> création de demande -> matching
app.post('/api/ai/conversations/:id/convert-and-match', auth, (req,res)=>{
  const id=Number(req.params.id);
  const c=db.prepare(`SELECT * FROM ai_conversations WHERE id=? AND user_id=?`).get(id,req.user.id);
  if(!c) return res.status(404).json({error:'Conversation introuvable'});

  let d=db.prepare(`SELECT * FROM ai_request_drafts WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(id);
  if(!d || !d.category || !d.problem || !d.zone)
    return res.status(400).json({error:'La demande doit être suffisamment renseignée avant le matching'});

  let requestId=c.request_id;
  if(!requestId){
    const r=db.prepare(`INSERT INTO requests(client_id,category,description,zone,preferred_time,status,user_id,title,problem,service,location,budget) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.id,d.category,d.problem,d.zone,null,'OPEN',req.user.id,d.category,d.problem,d.category,d.zone,d.budget?Number(String(d.budget).replace(/[^0-9]/g,''))||null:null);
    requestId=r.lastInsertRowid;
    db.prepare(`UPDATE ai_conversations SET request_id=?,status='CONVERTED',updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(requestId,id);
  }

  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(requestId);
  const pros=db.prepare(`
    SELECT p.*, COALESCE(p.availability,'') availability
    FROM professionals p
  `).all();

  const matches=pros.map(p=>{
    const m=kokoMatchScore(request,p);
    return {...p,match_score:m.score,match_reasons:m.reasons};
  }).filter(x=>x.match_score>15).sort((a,b)=>b.match_score-a.match_score).slice(0,10);

  const ins=db.prepare(`INSERT INTO matching_events(request_id,professional_id,score,reasons) VALUES(?,?,?,?)`);
  const tx=db.transaction(rows=>rows.forEach(x=>ins.run(requestId,x.id,x.match_score,JSON.stringify(x.match_reasons))));
  tx(matches);

  res.json({
    request_id:requestId,
    request:{category:request.category,problem:request.problem,zone:request.zone,budget:request.budget||null},
    matches:matches.map(x=>({
      professional_id:x.id,
      name:x.name,
      company_name:x.company_name,
      category:x.category,
      zone:x.zone,
      rating:x.rating,
      verified:!!x.verified,
      availability:x.availability,
      match_score:x.match_score,
      reasons:x.match_reasons
    }))
  });
});

// Choix explicite d'un professionnel après présentation des résultats
app.post('/api/requests/:id/select-professional', auth, (req,res)=>{
  const request=db.prepare(`SELECT * FROM requests WHERE id=? AND user_id=?`).get(Number(req.params.id),req.user.id);
  if(!request) return res.status(404).json({error:'Demande introuvable'});
  const professionalId=Number(req.body.professional_id);
  const p=db.prepare(`SELECT id FROM professionals WHERE id=?`).get(professionalId);
  if(!p) return res.status(404).json({error:'Professionnel introuvable'});

  // On ne force pas de sélection commerciale : on crée une notification de mise en relation.
  const userRow=db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(professionalId);
  if(userRow && userRow.user_id){
    try{
      createKokoNotification(
        userRow.user_id,
        'NEW_MATCH_REQUEST',
        'Nouvelle demande KÔKÔ',
        `Une demande correspondant à vos services est disponible (#${request.id}).`,
        request.id,
        null,
        null
      );
    }catch(e){}
  }

  res.json({ok:true,request_id:request.id,professional_id:professionalId,status:'CONTACT_REQUESTED'});
});

// Analyse simple de compatibilité affichable au client
app.get('/api/requests/:id/matching-summary', auth, (req,res)=>{
  const request=db.prepare(`SELECT * FROM requests WHERE id=? AND user_id=?`).get(Number(req.params.id),req.user.id);
  if(!request) return res.status(404).json({error:'Demande introuvable'});
  const rows=db.prepare(`
    SELECT me.professional_id, me.score, me.reasons, me.created_at,
           p.name,p.company_name,p.category,p.zone,p.rating,p.verified
    FROM matching_events me
    JOIN professionals p ON p.id=me.professional_id
    WHERE me.request_id=?
    ORDER BY me.score DESC, me.created_at DESC
  `).all(request.id);

  const seen=new Set(), clean=[];
  for(const r of rows){
    if(seen.has(r.professional_id)) continue;
    seen.add(r.professional_id);
    clean.push({...r,reasons:JSON.parse(r.reasons||'[]')});
  }
  res.json({request_id:request.id,matches:clean.slice(0,10)});
});


// KOKO_V22_QUOTE_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS quote_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL UNIQUE,
  estimated_duration TEXT,
  start_date TEXT,
  materials_included INTEGER NOT NULL DEFAULT 0,
  materials_description TEXT,
  warranty_text TEXT,
  payment_terms TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quote_details_quote ON quote_details(quote_id);

CREATE TABLE IF NOT EXISTS quote_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quote_events_quote ON quote_events(quote_id);
`);


// KOKO_V22_QUOTE_ROUTES

function kokoQuoteAccess(quoteId,userId){
  return db.prepare(`
    SELECT q.*, r.user_id AS client_user_id, p.user_id AS pro_user_id
    FROM quotes q
    JOIN requests r ON r.id=q.request_id
    JOIN professionals p ON p.id=q.professional_id
    WHERE q.id=?`).get(quoteId);
}

// Professional creates/updates a detailed quote.
// Amount is the proposed total; no payment is triggered here.
app.post('/api/quotes/:id/details', auth, (req,res)=>{
  const q=kokoQuoteAccess(Number(req.params.id),req.user.id);
  if(!q || q.pro_user_id!==req.user.id) return res.status(403).json({error:'Accès professionnel requis'});

  const estimated_duration=String(req.body.estimated_duration||'').trim();
  const start_date=String(req.body.start_date||'').trim();
  const materials_included=req.body.materials_included?1:0;
  const materials_description=String(req.body.materials_description||'').trim();
  const warranty_text=String(req.body.warranty_text||'').trim();
  const payment_terms=String(req.body.payment_terms||'').trim();
  const notes=String(req.body.notes||'').trim();

  const existing=db.prepare(`SELECT id FROM quote_details WHERE quote_id=?`).get(q.id);
  if(existing){
    db.prepare(`UPDATE quote_details SET estimated_duration=?,start_date=?,materials_included=?,materials_description=?,warranty_text=?,payment_terms=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE quote_id=?`)
      .run(estimated_duration,start_date,materials_included,materials_description,warranty_text,payment_terms,notes,q.id);
  } else {
    db.prepare(`INSERT INTO quote_details(quote_id,estimated_duration,start_date,materials_included,materials_description,warranty_text,payment_terms,notes) VALUES(?,?,?,?,?,?,?,?)`)
      .run(q.id,estimated_duration,start_date,materials_included,materials_description,warranty_text,payment_terms,notes);
  }
  db.prepare(`INSERT INTO quote_events(quote_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(q.id,req.user.id,'DETAILS_UPDATED',JSON.stringify({estimated_duration,start_date,materials_included}));
  res.json({ok:true,quote_id:q.id});
});

// Client views structured quotes for comparison.
app.get('/api/requests/:id/quotes/intelligent', auth, (req,res)=>{
  const request=db.prepare(`SELECT * FROM requests WHERE id=? AND user_id=?`).get(Number(req.params.id),req.user.id);
  if(!request) return res.status(404).json({error:'Demande introuvable'});

  const rows=db.prepare(`
    SELECT q.*, p.name AS professional_name,p.company_name,p.category,p.zone,p.rating,p.verified,
           qd.estimated_duration,qd.start_date,qd.materials_included,qd.materials_description,
           qd.warranty_text,qd.payment_terms,qd.notes
    FROM quotes q
    JOIN professionals p ON p.id=q.professional_id
    LEFT JOIN quote_details qd ON qd.quote_id=q.id
    WHERE q.request_id=?
    ORDER BY q.created_at DESC`).all(request.id);

  res.json({
    request:{id:request.id,category:request.category,problem:request.problem,zone:request.zone,budget:request.budget||null},
    quotes:rows
  });
});

// Client accepts one quote explicitly. Other pending quotes are closed.
app.post('/api/quotes/:id/accept-intelligent', auth, (req,res)=>{
  const q=kokoQuoteAccess(Number(req.params.id),req.user.id);
  if(!q || q.client_user_id!==req.user.id) return res.status(403).json({error:'Accès client requis'});
  if(['ACCEPTED','WITHDRAWN','REJECTED'].includes(String(q.status||'').toUpperCase()))
    return res.status(400).json({error:'Ce devis ne peut plus être accepté'});

  const tx=db.transaction(()=>{
    db.prepare(`UPDATE quotes SET status='ACCEPTED' WHERE id=?`).run(q.id);
    db.prepare(`UPDATE quotes SET status='REJECTED' WHERE request_id=? AND id<>? AND status NOT IN ('ACCEPTED','WITHDRAWN','REJECTED')`)
      .run(q.request_id,q.id);
    db.prepare(`UPDATE requests SET status='QUOTE_ACCEPTED' WHERE id=?`).run(q.request_id);
    db.prepare(`INSERT INTO quote_events(quote_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
      .run(q.id,req.user.id,'ACCEPTED','Client a choisi ce devis');
  });
  tx();

  try{
    createKokoNotification(q.pro_user_id,'QUOTE_ACCEPTED','Devis accepté',`Votre devis #${q.id} a été accepté pour la demande #${q.request_id}.`,q.request_id,null,null);
  }catch(e){}
  res.json({ok:true,quote_id:q.id,request_id:q.request_id,status:'ACCEPTED'});
});

// Client can reject/withdraw interest in a quote without accepting another.
app.post('/api/quotes/:id/reject-intelligent', auth, (req,res)=>{
  const q=kokoQuoteAccess(Number(req.params.id),req.user.id);
  if(!q || q.client_user_id!==req.user.id) return res.status(403).json({error:'Accès client requis'});
  if(String(q.status).toUpperCase()==='ACCEPTED') return res.status(400).json({error:'Un devis déjà accepté ne peut pas être rejeté ici'});
  db.prepare(`UPDATE quotes SET status='REJECTED' WHERE id=?`).run(q.id);
  db.prepare(`INSERT INTO quote_events(quote_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`).run(q.id,req.user.id,'REJECTED','Devis rejeté par le client');
  res.json({ok:true});
});

// Event history for transparency.
app.get('/api/quotes/:id/events', auth, (req,res)=>{
  const q=kokoQuoteAccess(Number(req.params.id),req.user.id);
  if(!q || ![q.client_user_id,q.pro_user_id].includes(req.user.id))
    return res.status(403).json({error:'Accès refusé'});
  res.json(db.prepare(`SELECT * FROM quote_events WHERE quote_id=? ORDER BY created_at ASC`).all(q.id));
});


// KOKO_V23_PAYMENT_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS payment_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  quote_id INTEGER NOT NULL,
  payer_user_id INTEGER NOT NULL,
  professional_user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XOF',
  purpose TEXT NOT NULL DEFAULT 'DEPOSIT',
  provider TEXT NOT NULL DEFAULT 'SIMULATOR',
  method TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  provider_reference TEXT,
  idempotency_key TEXT UNIQUE,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_request ON payment_intents(request_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_quote ON payment_intents(quote_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_intent_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_events_intent ON payment_events(payment_intent_id);
`);


// KOKO_V23_PAYMENT_ROUTES

function kokoPaymentQuoteAccess(quoteId,userId){
  return db.prepare(`
    SELECT q.*, r.user_id AS client_user_id, p.user_id AS pro_user_id
    FROM quotes q
    JOIN requests r ON r.id=q.request_id
    JOIN professionals p ON p.id=q.professional_id
    WHERE q.id=?`).get(quoteId);
}

// Create a payment intent for an already accepted quote.
// This does NOT charge the client. It creates a payment instruction.
app.post('/api/payments/intents', auth, (req,res)=>{
  const quoteId=Number(req.body.quote_id);
  const q=kokoPaymentQuoteAccess(quoteId,req.user.id);
  if(!q || q.client_user_id!==req.user.id) return res.status(403).json({error:'Accès client requis'});
  if(String(q.status).toUpperCase()!=='ACCEPTED') return res.status(400).json({error:'Le devis doit être accepté avant le paiement'});

  const amount=Number(req.body.amount);
  if(!Number.isInteger(amount) || amount<=0) return res.status(400).json({error:'Montant invalide'});

  const purpose=String(req.body.purpose||'DEPOSIT').toUpperCase();
  const method=String(req.body.method||'').toUpperCase();
  const allowed=['DEPOSIT','FULL_PAYMENT'];
  const methods=['SIMULATOR','ORANGE_MONEY_CI','MTN_CI','MOOV_CI','WAVE_CI','DJAMO_CI','CARD'];
  if(!allowed.includes(purpose)) return res.status(400).json({error:'Objet de paiement invalide'});
  if(!methods.includes(method)) return res.status(400).json({error:'Méthode de paiement non disponible'});

  const idem=String(req.body.idempotency_key||`${req.user.id}-${q.id}-${purpose}-${amount}-${Date.now()}`);
  const previous=db.prepare(`SELECT * FROM payment_intents WHERE idempotency_key=?`).get(idem);
  if(previous) return res.json({payment:previous,reused:true});

  const info=db.prepare(`
    INSERT INTO payment_intents(request_id,quote_id,payer_user_id,professional_user_id,amount,currency,purpose,provider,method,status,idempotency_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(q.request_id,q.id,req.user.id,q.pro_user_id,amount,'XOF',purpose,'SIMULATOR',method,'CREATED',idem);

  const payment=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(info.lastInsertRowid);
  db.prepare(`INSERT INTO payment_events(payment_intent_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(payment.id,req.user.id,'CREATED',JSON.stringify({amount,purpose,method}));

  res.status(201).json({
    payment,
    next_step:'REDIRECT_OR_PROVIDER_CHECKOUT',
    message:'Intention de paiement créée. Aucun débit réel n’a été effectué.'
  });
});

app.get('/api/payments/intents/:id', auth, (req,res)=>{
  const p=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(Number(req.params.id));
  if(!p || ![p.payer_user_id,p.professional_user_id].includes(req.user.id))
    return res.status(403).json({error:'Accès refusé'});
  res.json({payment:p,events:db.prepare(`SELECT * FROM payment_events WHERE payment_intent_id=? ORDER BY created_at ASC`).all(p.id)});
});

// Prototype-only simulator. Disabled in production.
app.post('/api/payments/intents/:id/simulate-success', auth, (req,res)=>{
  if(process.env.NODE_ENV==='production') return res.status(403).json({error:'Simulation désactivée en production'});
  const p=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(Number(req.params.id));
  if(!p || p.payer_user_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
  if(p.status!=='CREATED') return res.status(400).json({error:'Paiement déjà traité'});
  const ref='SIM-'+Date.now()+'-'+p.id;
  db.prepare(`UPDATE payment_intents SET status='SUCCESS',provider_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(ref,p.id);
  db.prepare(`INSERT INTO payment_events(payment_intent_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(p.id,req.user.id,'SUCCESS',JSON.stringify({provider_reference:ref}));
  try{
    createKokoNotification(p.professional_user_id,'PAYMENT_SUCCESS','Paiement confirmé',`Paiement confirmé pour la demande #${p.request_id}.`,p.request_id,null,null);
  }catch(e){}
  res.json({ok:true,payment:db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(p.id)});
});

// Cancellation before success.
app.post('/api/payments/intents/:id/cancel', auth, (req,res)=>{
  const p=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(Number(req.params.id));
  if(!p || p.payer_user_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
  if(p.status==='SUCCESS') return res.status(400).json({error:'Un paiement confirmé ne peut pas être annulé ici'});
  db.prepare(`UPDATE payment_intents SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(p.id);
  db.prepare(`INSERT INTO payment_events(payment_intent_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(p.id,req.user.id,'CANCELLED','Annulation avant paiement confirmé');
  res.json({ok:true});
});

// Provider webhook placeholder: verify signatures and idempotency before production use.
app.post('/api/payments/provider/webhook', (req,res)=>{
  res.status(501).json({error:'Webhook réel non activé. Configurer signature, secret, idempotence et réconciliation du prestataire.'});
});


// KOKO_V24_FINANCE_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  request_id INTEGER NOT NULL,
  quote_id INTEGER NOT NULL,
  payment_intent_id INTEGER,
  client_user_id INTEGER NOT NULL,
  professional_user_id INTEGER NOT NULL,
  subtotal INTEGER NOT NULL,
  koko_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XOF',
  status TEXT NOT NULL DEFAULT 'ISSUED',
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_pro ON invoices(professional_user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_request ON invoices(request_id);

CREATE TABLE IF NOT EXISTS finance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_intent_id INTEGER,
  invoice_id INTEGER,
  request_id INTEGER,
  quote_id INTEGER,
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XOF',
  user_id INTEGER,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_payment ON finance_ledger(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice ON finance_ledger(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id);
`);


// KOKO_V24_FINANCE_ROUTES

function kokoMakeInvoiceNumber(){
  return 'KOKO-'+new Date().getFullYear()+'-'+Date.now().toString().slice(-8);
}

function kokoInvoiceAccess(invoiceId,userId){
  return db.prepare(`SELECT * FROM invoices WHERE id=? AND (client_user_id=? OR professional_user_id=?)`)
    .get(invoiceId,userId,userId);
}

// Create an invoice only from an accepted quote.
app.post('/api/finance/invoices', auth, (req,res)=>{
  const quoteId=Number(req.body.quote_id);
  const q=kokoPaymentQuoteAccess(quoteId,req.user.id);
  if(!q || q.client_user_id!==req.user.id) return res.status(403).json({error:'Accès client requis'});
  if(String(q.status).toUpperCase()!=='ACCEPTED') return res.status(400).json({error:'Le devis doit être accepté'});
  const subtotal=Number(req.body.subtotal);
  const feePercent=Number(req.body.koko_fee_percent||0);
  if(!Number.isInteger(subtotal)||subtotal<=0) return res.status(400).json({error:'Montant invalide'});
  if(!Number.isFinite(feePercent)||feePercent<0||feePercent>100) return res.status(400).json({error:'Commission invalide'});
  const kokoFee=Math.round(subtotal*feePercent/100);
  const total=subtotal+kokoFee;
  const invoiceNumber=kokoMakeInvoiceNumber();

  const info=db.prepare(`
    INSERT INTO invoices(invoice_number,request_id,quote_id,client_user_id,professional_user_id,subtotal,koko_fee,total)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(invoiceNumber,q.request_id,q.id,q.client_user_id,q.pro_user_id,subtotal,kokoFee,total);
  const invoice=db.prepare(`SELECT * FROM invoices WHERE id=?`).get(info.lastInsertRowid);
  db.prepare(`INSERT INTO invoice_events(invoice_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
    .run(invoice.id,req.user.id,'ISSUED',JSON.stringify({subtotal,kokoFee,total}));
  res.status(201).json({invoice});
});

// Link a successful payment to an invoice and create immutable-ish ledger entries.
app.post('/api/finance/invoices/:id/link-payment', auth, (req,res)=>{
  const invoice=kokoInvoiceAccess(Number(req.params.id),req.user.id);
  if(!invoice) return res.status(403).json({error:'Accès refusé'});
  const paymentId=Number(req.body.payment_intent_id);
  const payment=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(paymentId);
  if(!payment || payment.request_id!==invoice.request_id || payment.quote_id!==invoice.quote_id)
    return res.status(400).json({error:'Paiement incompatible'});
  if(payment.status!=='SUCCESS') return res.status(400).json({error:'Le paiement doit être confirmé'});
  if(payment.amount!==invoice.total) return res.status(400).json({error:'Le montant du paiement ne correspond pas à la facture'});

  const tx=db.transaction(()=>{
    db.prepare(`UPDATE invoices SET payment_intent_id=?,status='PAID',paid_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(payment.id,invoice.id);
    const exists=db.prepare(`SELECT id FROM finance_ledger WHERE payment_intent_id=?`).get(payment.id);
    if(!exists){
      db.prepare(`INSERT INTO finance_ledger(payment_intent_id,invoice_id,request_id,quote_id,entry_type,amount,user_id,description) VALUES(?,?,?,?,?,?,?,?)`)
        .run(payment.id,invoice.id,invoice.request_id,invoice.quote_id,'PAYMENT_CONFIRMED',payment.amount,invoice.client_user_id,'Paiement confirmé');
      if(invoice.koko_fee>0){
        db.prepare(`INSERT INTO finance_ledger(payment_intent_id,invoice_id,request_id,quote_id,entry_type,amount,user_id,description) VALUES(?,?,?,?,?,?,?,?)`)
          .run(payment.id,invoice.id,invoice.request_id,invoice.quote_id,'KOKO_FEE',invoice.koko_fee,null,'Commission KÔKÔ');
      }
      db.prepare(`INSERT INTO finance_ledger(payment_intent_id,invoice_id,request_id,quote_id,entry_type,amount,user_id,description) VALUES(?,?,?,?,?,?,?,?)`)
        .run(payment.id,invoice.id,invoice.request_id,invoice.quote_id,'PROFESSIONAL_NET',invoice.subtotal,invoice.professional_user_id,'Montant professionnel avant autres ajustements');
    }
    db.prepare(`INSERT INTO invoice_events(invoice_id,actor_user_id,event_type,details) VALUES(?,?,?,?)`)
      .run(invoice.id,req.user.id,'PAYMENT_LINKED',JSON.stringify({payment_id:payment.id}));
  });
  tx();
  res.json({ok:true,invoice:db.prepare(`SELECT * FROM invoices WHERE id=?`).get(invoice.id)});
});

// Invoice list for a user.
app.get('/api/finance/invoices', auth, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM invoices WHERE client_user_id=? OR professional_user_id=? ORDER BY created_at DESC`)
    .all(req.user.id,req.user.id);
  res.json(rows);
});

// Invoice details + ledger entries.
app.get('/api/finance/invoices/:id', auth, (req,res)=>{
  const invoice=kokoInvoiceAccess(Number(req.params.id),req.user.id);
  if(!invoice) return res.status(404).json({error:'Facture introuvable'});
  const ledger=db.prepare(`SELECT * FROM finance_ledger WHERE invoice_id=? ORDER BY created_at ASC`).all(invoice.id);
  const events=db.prepare(`SELECT * FROM invoice_events WHERE invoice_id=? ORDER BY created_at ASC`).all(invoice.id);
  res.json({invoice,ledger,events});
});

// Professional finance summary based ONLY on confirmed payment ledger.
app.get('/api/pro/finance/summary', auth, (req,res)=>{
  const totals=db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type='PAYMENT_CONFIRMED' THEN amount ELSE 0 END),0) AS gross_confirmed,
      COALESCE(SUM(CASE WHEN entry_type='PROFESSIONAL_NET' AND user_id=? THEN amount ELSE 0 END),0) AS professional_net,
      COUNT(DISTINCT CASE WHEN entry_type='PAYMENT_CONFIRMED' THEN payment_intent_id END) AS confirmed_payments
    FROM finance_ledger`).get(req.user.id);
  res.json(totals);
});

// Admin finance summary.
app.get('/api/admin/finance/summary-v24', auth, (req,res)=>{
  const totals=db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type='PAYMENT_CONFIRMED' THEN amount ELSE 0 END),0) AS gross_confirmed,
      COALESCE(SUM(CASE WHEN entry_type='KOKO_FEE' THEN amount ELSE 0 END),0) AS koko_fees,
      COALESCE(SUM(CASE WHEN entry_type='PROFESSIONAL_NET' THEN amount ELSE 0 END),0) AS professional_net,
      COUNT(DISTINCT CASE WHEN entry_type='PAYMENT_CONFIRMED' THEN payment_intent_id END) AS confirmed_payments
    FROM finance_ledger`).get();
  res.json(totals);
});

// Invoice event history.
app.get('/api/finance/invoices/:id/events', auth, (req,res)=>{
  const invoice=kokoInvoiceAccess(Number(req.params.id),req.user.id);
  if(!invoice) return res.status(403).json({error:'Accès refusé'});
  res.json(db.prepare(`SELECT * FROM invoice_events WHERE invoice_id=? ORDER BY created_at ASC`).all(invoice.id));
});


// KOKO_V25_DOCUMENT_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS financial_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_type TEXT NOT NULL,
  invoice_id INTEGER,
  payment_intent_id INTEGER,
  request_id INTEGER,
  owner_user_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fin_docs_owner ON financial_documents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fin_docs_invoice ON financial_documents(invoice_id);
`);


// KOKO_V25_DOCUMENT_ROUTES

function kokoDocSafe(s){
  return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function kokoDocumentDir(){
  const dir=require('path').join(__dirname,'uploads','financial-documents');
  require('fs').mkdirSync(dir,{recursive:true});
  return dir;
}
function kokoDocumentHtml(title, rows){
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
  <title>${kokoDocSafe(title)}</title>
  <style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#222}
  h1{margin-bottom:4px}.muted{color:#666}.row{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:10px 0}
  .total{font-size:20px;font-weight:bold;margin-top:20px}.footer{margin-top:40px;font-size:12px;color:#666}
  </style></head><body>
  <h1>${kokoDocSafe(title)}</h1>
  <p class="muted">Document généré par KÔKÔ — justificatif numérique.</p>
  ${rows.map(r=>`<div class="row"><span>${kokoDocSafe(r[0])}</span><strong>${kokoDocSafe(r[1])}</strong></div>`).join('')}
  <div class="footer">Ce document est généré à partir des données enregistrées dans KÔKÔ. Pour un usage fiscal ou réglementaire, la conformité du document doit être validée avant production.</div>
  </body></html>`;
}

// Generate a printable invoice document.
app.post('/api/documents/invoices/:id/generate', auth, (req,res)=>{
  const invoice=kokoInvoiceAccess(Number(req.params.id),req.user.id);
  if(!invoice) return res.status(403).json({error:'Accès refusé'});
  const rows=[
    ['N° facture',invoice.invoice_number],
    ['Demande',`#${invoice.request_id}`],
    ['Devis',`#${invoice.quote_id}`],
    ['Montant',`${invoice.subtotal} FCFA`],
    ['Commission KÔKÔ',`${invoice.koko_fee} FCFA`],
    ['Total',`${invoice.total} FCFA`],
    ['Statut',invoice.status],
    ['Émise le',invoice.issued_at],
    ['Payée le',invoice.paid_at||'Non payée']
  ];
  const fileName=`invoice_${invoice.id}_${invoice.invoice_number}.html`;
  const filePath=require('path').join(kokoDocumentDir(),fileName);
  require('fs').writeFileSync(filePath,kokoDocumentHtml(`Facture ${invoice.invoice_number}`,rows),'utf8');

  const old=db.prepare(`SELECT id FROM financial_documents WHERE document_type='INVOICE' AND invoice_id=?`).get(invoice.id);
  let docId;
  if(old){ docId=old.id; db.prepare(`UPDATE financial_documents SET file_name=?,file_path=? WHERE id=?`).run(fileName,filePath,docId); }
  else {
    docId=db.prepare(`INSERT INTO financial_documents(document_type,invoice_id,request_id,owner_user_id,file_name,file_path) VALUES(?,?,?,?,?,?)`)
      .run('INVOICE',invoice.id,invoice.request_id,req.user.id,fileName,filePath).lastInsertRowid;
  }
  res.json({ok:true,document_id:docId,file_name:fileName,download_url:`/api/documents/${docId}/download`});
});

// Generate a printable payment receipt only for SUCCESS payments.
app.post('/api/documents/payments/:id/receipt', auth, (req,res)=>{
  const p=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(Number(req.params.id));
  if(!p || ![p.payer_user_id,p.professional_user_id].includes(req.user.id))
    return res.status(403).json({error:'Accès refusé'});
  if(p.status!=='SUCCESS') return res.status(400).json({error:'Un reçu ne peut être généré que pour un paiement confirmé'});

  const rows=[
    ['Reçu de paiement',`#${p.id}`],
    ['Demande',`#${p.request_id}`],
    ['Devis',`#${p.quote_id}`],
    ['Montant',`${p.amount} ${p.currency}`],
    ['Objet',p.purpose],
    ['Méthode',p.method||''],
    ['Fournisseur',p.provider||''],
    ['Référence',p.provider_reference||''],
    ['Statut',p.status],
    ['Date',p.updated_at]
  ];
  const fileName=`receipt_payment_${p.id}.html`;
  const filePath=require('path').join(kokoDocumentDir(),fileName);
  require('fs').writeFileSync(filePath,kokoDocumentHtml(`Reçu de paiement #${p.id}`,rows),'utf8');

  const old=db.prepare(`SELECT id FROM financial_documents WHERE document_type='RECEIPT' AND payment_intent_id=?`).get(p.id);
  let docId;
  if(old){docId=old.id;db.prepare(`UPDATE financial_documents SET file_name=?,file_path=? WHERE id=?`).run(fileName,filePath,docId);}
  else {
    docId=db.prepare(`INSERT INTO financial_documents(document_type,payment_intent_id,request_id,owner_user_id,file_name,file_path) VALUES(?,?,?,?,?,?)`)
      .run('RECEIPT',p.id,p.request_id,req.user.id,fileName,filePath).lastInsertRowid;
  }
  res.json({ok:true,document_id:docId,file_name:fileName,download_url:`/api/documents/${docId}/download`});
});

// Secure document download.
app.get('/api/documents/:id/download', auth, (req,res)=>{
  const doc=db.prepare(`SELECT * FROM financial_documents WHERE id=?`).get(Number(req.params.id));
  if(!doc || doc.owner_user_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
  if(!require('fs').existsSync(doc.file_path)) return res.status(404).json({error:'Fichier introuvable'});
  res.download(doc.file_path,doc.file_name);
});

app.get('/api/documents', auth, (req,res)=>{
  const docs=db.prepare(`SELECT id,document_type,invoice_id,payment_intent_id,request_id,file_name,mime_type,created_at FROM financial_documents WHERE owner_user_id=? ORDER BY created_at DESC`).all(req.user.id);
  res.json(docs);
});


// KOKO_V26_REPUTATION_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS professional_reputation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professional_id INTEGER NOT NULL UNIQUE,
  completed_interventions INTEGER NOT NULL DEFAULT 0,
  confirmed_paid_jobs INTEGER NOT NULL DEFAULT 0,
  average_rating REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  five_star_rate REAL NOT NULL DEFAULT 0,
  response_rate REAL NOT NULL DEFAULT 0,
  dispute_rate REAL NOT NULL DEFAULT 0,
  cancellation_rate REAL NOT NULL DEFAULT 0,
  repeat_client_rate REAL NOT NULL DEFAULT 0,
  reliability_score REAL NOT NULL DEFAULT 0,
  last_calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prof_rep_prof ON professional_reputation(professional_id);

CREATE TABLE IF NOT EXISTS reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professional_id INTEGER NOT NULL,
  request_id INTEGER,
  event_type TEXT NOT NULL,
  score_before REAL,
  score_after REAL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rep_events_prof ON reputation_events(professional_id);
`);


// KOKO_V26_REPUTATION_ROUTES

function kokoCalcProfessionalReputation(professionalId){
  const p=db.prepare(`SELECT * FROM professionals WHERE id=?`).get(professionalId);
  if(!p) return null;

  const completed=db.prepare(`
    SELECT COUNT(*) AS c FROM interventions i
    JOIN quotes q ON q.id=i.quote_id
    WHERE q.professional_id=? AND i.status IN ('COMPLETED','VALIDATED')`).get(professionalId).c;

  const paid=db.prepare(`
    SELECT COUNT(DISTINCT pi.request_id) AS c FROM payment_intents pi
    JOIN quotes q ON q.id=pi.quote_id
    WHERE q.professional_id=? AND pi.status='SUCCESS'`).get(professionalId).c;

  const ratings=db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(AVG(rating),0) AS avg,
           COALESCE(SUM(CASE WHEN rating>=5 THEN 1 ELSE 0 END),0) AS five
    FROM reviews WHERE professional_id=?`).get(professionalId);

  const jobs=db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status IN ('COMPLETED','VALIDATED') THEN 1 ELSE 0 END),0) AS done,
           COALESCE(SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END),0) AS cancelled
    FROM interventions i JOIN quotes q ON q.id=i.quote_id
    WHERE q.professional_id=?`).get(professionalId);

  const disputes=db.prepare(`
    SELECT COUNT(*) AS c FROM disputes d
    JOIN requests r ON r.id=d.request_id
    JOIN quotes q ON q.request_id=r.id
    WHERE q.professional_id=?`).get(professionalId).c;

  const requestsReceived=db.prepare(`
    SELECT COUNT(*) AS c FROM matching_events WHERE professional_id=?`).get(professionalId).c;
  const requestsResponded=db.prepare(`
    SELECT COUNT(DISTINCT q.request_id) AS c FROM quotes q WHERE q.professional_id=?`).get(professionalId).c;

  const repeat=db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT r.user_id, COUNT(*) AS n
      FROM requests r JOIN quotes q ON q.request_id=r.id
      WHERE q.professional_id=? AND q.status='ACCEPTED'
      GROUP BY r.user_id HAVING n>1
    )`).get(professionalId).c;
  const distinctClients=db.prepare(`
    SELECT COUNT(DISTINCT r.user_id) AS c FROM requests r JOIN quotes q ON q.request_id=r.id
    WHERE q.professional_id=? AND q.status='ACCEPTED'`).get(professionalId).c;

  const responseRate=requestsReceived ? Math.min(100,(requestsResponded/requestsReceived)*100) : 0;
  const disputeRate=completed ? Math.min(100,(disputes/completed)*100) : 0;
  const cancellationRate=jobs.total ? Math.min(100,(jobs.cancelled/jobs.total)*100) : 0;
  const repeatRate=distinctClients ? Math.min(100,(repeat/distinctClients)*100) : 0;
  const fiveRate=ratings.c ? (ratings.five/ratings.c)*100 : 0;

  // Transparent prototype score: ratings + response + completion + dispute/cancellation penalties.
  const ratingComponent=ratings.c ? Math.min(100,(ratings.avg/5)*100) : 0;
  const completionRate=jobs.total ? (jobs.done/jobs.total)*100 : 0;
  const reliability=ratings.c ? (
    ratingComponent*0.45 +
    responseRate*0.15 +
    completionRate*0.20 +
    Math.max(0,100-disputeRate)*0.10 +
    Math.max(0,100-cancellationRate)*0.10
  ) : 0;

  db.prepare(`
    INSERT INTO professional_reputation(professional_id,completed_interventions,confirmed_paid_jobs,average_rating,rating_count,five_star_rate,response_rate,dispute_rate,cancellation_rate,repeat_client_rate,reliability_score,last_calculated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(professional_id) DO UPDATE SET
      completed_interventions=excluded.completed_interventions,
      confirmed_paid_jobs=excluded.confirmed_paid_jobs,
      average_rating=excluded.average_rating,
      rating_count=excluded.rating_count,
      five_star_rate=excluded.five_star_rate,
      response_rate=excluded.response_rate,
      dispute_rate=excluded.dispute_rate,
      cancellation_rate=excluded.cancellation_rate,
      repeat_client_rate=excluded.repeat_client_rate,
      reliability_score=excluded.reliability_score,
      last_calculated_at=CURRENT_TIMESTAMP
  `).run(professionalId,completed,paid,ratings.avg,ratings.c,fiveRate,responseRate,disputeRate,cancellationRate,repeatRate,reliability);

  return db.prepare(`SELECT * FROM professional_reputation WHERE professional_id=?`).get(professionalId);
}

// Public professional reputation: only aggregate indicators.
app.get('/api/professionals/:id/reputation', auth, (req,res)=>{
  const rep=kokoCalcProfessionalReputation(Number(req.params.id));
  if(!rep) return res.status(404).json({error:'Professionnel introuvable'});
  res.json(rep);
});

// Professional's own reputation dashboard.
app.get('/api/pro/reputation/advanced', auth, (req,res)=>{
  const pro=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(req.user.id);
  if(!pro) return res.status(404).json({error:'Profil professionnel introuvable'});
  const rep=kokoCalcProfessionalReputation(pro.id);
  const recent=db.prepare(`
    SELECT r.id,r.rating,r.comment,r.created_at,req.id AS request_id
    FROM reviews r JOIN requests req ON req.id=r.request_id
    WHERE r.professional_id=? ORDER BY r.created_at DESC LIMIT 20`).all(pro.id);
  res.json({reputation:rep,recent_reviews:recent});
});

// Recalculate all professional reputation metrics (admin).
app.post('/api/admin/reputation/recalculate', auth, (req,res)=>{
  const pros=db.prepare(`SELECT id FROM professionals`).all();
  for(const p of pros) kokoCalcProfessionalReputation(p.id);
  res.json({ok:true,count:pros.length});
});

// Audit-friendly reputation event list.
app.get('/api/professionals/:id/reputation/events', auth, (req,res)=>{
  const rep=db.prepare(`SELECT id,professional_id FROM professional_reputation WHERE professional_id=?`).get(Number(req.params.id));
  if(!rep) return res.json([]);
  res.json(db.prepare(`SELECT * FROM reputation_events WHERE professional_id=? ORDER BY created_at DESC LIMIT 100`).all(rep.professional_id));
});


// KOKO_V27_ANTIFRAUD_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS fraud_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  professional_id INTEGER,
  request_id INTEGER,
  review_id INTEGER,
  payment_intent_id INTEGER,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'LOW',
  score INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_user ON fraud_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_pro ON fraud_flags(professional_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status);

CREATE TABLE IF NOT EXISTS review_integrity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL UNIQUE,
  reviewer_user_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL,
  paid_job INTEGER NOT NULL DEFAULT 0,
  completed_job INTEGER NOT NULL DEFAULT 0,
  duplicate_similarity INTEGER NOT NULL DEFAULT 0,
  integrity_status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_review_integrity_pro ON review_integrity(professional_id);

CREATE TABLE IF NOT EXISTS trust_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  professional_id INTEGER,
  event_type TEXT NOT NULL,
  score_delta INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);


// KOKO_V27_ANTIFRAUD_ROUTES

function kokoFraudFlag(data){
  const info=db.prepare(`
    INSERT INTO fraud_flags(user_id,professional_id,request_id,review_id,payment_intent_id,flag_type,severity,score,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
      data.user_id||null,data.professional_id||null,data.request_id||null,data.review_id||null,
      data.payment_intent_id||null,data.flag_type,data.severity||'LOW',data.score||0,data.reason
    );
  db.prepare(`INSERT INTO trust_events(user_id,professional_id,event_type,score_delta,reason) VALUES(?,?,?,?,?)`)
    .run(data.user_id||null,data.professional_id||null,'FRAUD_FLAG',-(data.score||0),data.reason);
  return info.lastInsertRowid;
}

// Review integrity check: review must be tied to the reviewer and a real completed/paid job.
function kokoCheckReviewIntegrity(reviewId){
  const r=db.prepare(`SELECT * FROM reviews WHERE id=?`).get(reviewId);
  if(!r) return null;
  const req=db.prepare(`SELECT * FROM requests WHERE id=?`).get(r.request_id);
  const paid=db.prepare(`
    SELECT COUNT(*) c FROM payment_intents
    WHERE request_id=? AND payer_user_id=? AND status='SUCCESS'`).get(r.request_id,req?.user_id||-1).c>0;
  const completed=db.prepare(`
    SELECT COUNT(*) c FROM interventions i
    JOIN quotes q ON q.id=i.quote_id
    WHERE i.request_id=? AND q.professional_id=? AND i.status IN ('COMPLETED','VALIDATED')`)
    .get(r.request_id,r.professional_id).c>0;

  let status=(paid && completed)?'VERIFIED':'REVIEW';
  let reason=(paid && completed)?'Avis lié à une intervention terminée et à un paiement confirmé':'Avis à vérifier : absence de preuve complète de paiement/intervention';

  const existing=db.prepare(`SELECT id FROM review_integrity WHERE review_id=?`).get(reviewId);
  if(existing){
    db.prepare(`UPDATE review_integrity SET paid_job=?,completed_job=?,integrity_status=?,reason=?,checked_at=CURRENT_TIMESTAMP WHERE review_id=?`)
      .run(paid?1:0,completed?1:0,status,reason,reviewId);
  }else{
    db.prepare(`INSERT INTO review_integrity(review_id,reviewer_user_id,professional_id,request_id,paid_job,completed_job,integrity_status,reason)
      VALUES(?,?,?,?,?,?,?,?)`).run(reviewId,req?.user_id||0,r.professional_id,r.request_id,paid?1:0,completed?1:0,status,reason);
  }
  return db.prepare(`SELECT * FROM review_integrity WHERE review_id=?`).get(reviewId);
}

// Scan a professional for simple prototype risk signals.
app.get('/api/professionals/:id/trust-check', auth, (req,res)=>{
  const professionalId=Number(req.params.id);
  const p=db.prepare(`SELECT * FROM professionals WHERE id=?`).get(professionalId);
  if(!p) return res.status(404).json({error:'Professionnel introuvable'});

  const flags=[];
  const reviews=db.prepare(`SELECT id FROM reviews WHERE professional_id=?`).all(professionalId);
  let verifiedReviews=0, pendingReviews=0;
  for(const r of reviews){
    const integrity=kokoCheckReviewIntegrity(r.id);
    if(integrity?.integrity_status==='VERIFIED') verifiedReviews++;
    else pendingReviews++;
  }

  const disputes=db.prepare(`
    SELECT COUNT(*) c FROM disputes d
    JOIN requests r ON r.id=d.request_id
    JOIN quotes q ON q.request_id=r.id
    WHERE q.professional_id=?`).get(professionalId).c;

  const paidJobs=db.prepare(`
    SELECT COUNT(DISTINCT request_id) c FROM payment_intents pi
    JOIN quotes q ON q.id=pi.quote_id WHERE q.professional_id=? AND pi.status='SUCCESS'`)
    .get(professionalId).c;

  const completed=db.prepare(`
    SELECT COUNT(*) c FROM interventions i JOIN quotes q ON q.id=i.quote_id
    WHERE q.professional_id=? AND i.status IN ('COMPLETED','VALIDATED')`).get(professionalId).c;

  if(reviews.length>=3 && verifiedReviews===0)
    flags.push({type:'REVIEWS_UNVERIFIED',severity:'HIGH',score:30,reason:'Aucun des avis analysés n’est actuellement relié à une preuve complète de paiement et d’intervention.'});
  if(disputes>=3)
    flags.push({type:'HIGH_DISPUTE_VOLUME',severity:'MEDIUM',score:20,reason:'Volume de litiges élevé dans les données disponibles.'});
  if(paidJobs===0 && completed>0)
    flags.push({type:'COMPLETED_WITHOUT_CONFIRMED_PAYMENT',severity:'MEDIUM',score:15,reason:'Interventions terminées détectées sans paiement confirmé correspondant.'});

  res.json({
    professional_id:professionalId,
    reviews_total:reviews.length,
    verified_reviews:verifiedReviews,
    reviews_to_review:pendingReviews,
    paid_jobs:paidJobs,
    completed_interventions:completed,
    disputes,
    flags,
    note:'Les signaux sont des indicateurs de contrôle et ne constituent pas une conclusion de fraude.'
  });
});

// Admin scans all professionals and creates flags.
app.post('/api/admin/antifraud/scan', auth, (req,res)=>{
  const pros=db.prepare(`SELECT id FROM professionals`).all();
  let created=0;
  for(const p of pros){
    const reviews=db.prepare(`SELECT id FROM reviews WHERE professional_id=?`).all(p.id);
    let verified=0;
    for(const r of reviews){
      const integrity=kokoCheckReviewIntegrity(r.id);
      if(integrity?.integrity_status==='VERIFIED') verified++;
    }
    const disputes=db.prepare(`
      SELECT COUNT(*) c FROM disputes d JOIN requests r ON r.id=d.request_id
      JOIN quotes q ON q.request_id=r.id WHERE q.professional_id=?`).get(p.id).c;
    if(reviews.length>=3 && verified===0){
      kokoFraudFlag({professional_id:p.id,flag_type:'REVIEWS_UNVERIFIED',severity:'HIGH',score:30,
        reason:'Tous les avis existants nécessitent une vérification de transaction/intervention.'});
      created++;
    }
    if(disputes>=3){
      kokoFraudFlag({professional_id:p.id,flag_type:'HIGH_DISPUTE_VOLUME',severity:'MEDIUM',score:20,
        reason:'Au moins trois litiges sont associés aux demandes de ce professionnel.'});
      created++;
    }
  }
  res.json({ok:true,professionals_scanned:pros.length,flags_created:created});
});

// Admin queue.
app.get('/api/admin/antifraud/flags', auth, (req,res)=>{
  const status=String(req.query.status||'OPEN').toUpperCase();
  res.json(db.prepare(`SELECT * FROM fraud_flags WHERE status=? ORDER BY score DESC,created_at DESC`).all(status));
});

app.post('/api/admin/antifraud/flags/:id/review', auth, (req,res)=>{
  const status=String(req.body.status||'REVIEWED').toUpperCase();
  if(!['REVIEWED','DISMISSED','CONFIRMED'].includes(status))
    return res.status(400).json({error:'Statut invalide'});
  db.prepare(`UPDATE fraud_flags SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=? WHERE id=?`)
    .run(status,req.user.id,Number(req.params.id));
  res.json({ok:true});
});

// Public review integrity indicator.
app.get('/api/reviews/:id/integrity', auth, (req,res)=>{
  const r=db.prepare(`SELECT * FROM reviews WHERE id=?`).get(Number(req.params.id));
  if(!r) return res.status(404).json({error:'Avis introuvable'});
  const i=kokoCheckReviewIntegrity(r.id);
  res.json({review_id:r.id,status:i.integrity_status,paid_job:!!i.paid_job,completed_job:!!i.completed_job,reason:i.reason});
});


// KOKO_V28_KYC_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS kyc_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  professional_id INTEGER,
  entity_type TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  legal_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  id_type TEXT,
  id_number_masked TEXT,
  verification_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  verification_level TEXT NOT NULL DEFAULT 'BASIC',
  submitted_at TEXT,
  verified_at TEXT,
  expires_at TEXT,
  rejection_reason TEXT,
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_profiles(verification_status);
CREATE INDEX IF NOT EXISTS idx_kyc_pro ON kyc_profiles(professional_id);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kyc_profile_id INTEGER NOT NULL,
  document_type TEXT NOT NULL,
  document_reference TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  issued_country TEXT,
  expires_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_profile ON kyc_documents(kyc_profile_id);

CREATE TABLE IF NOT EXISTS kyc_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kyc_profile_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kyc_events_profile ON kyc_events(kyc_profile_id);
`);


// KOKO_V28_KYC_ROUTES

function kokoKycProfileForUser(userId){
  return db.prepare(`SELECT * FROM kyc_profiles WHERE user_id=?`).get(userId);
}

app.get('/api/kyc/me', auth, (req,res)=>{
  let p=kokoKycProfileForUser(req.user.id);
  if(!p) return res.json({profile:null,documents:[],events:[]});
  const docs=db.prepare(`SELECT id,document_type,status,issued_country,expires_at,submitted_at,reviewed_at,rejection_reason
    FROM kyc_documents WHERE kyc_profile_id=? ORDER BY submitted_at DESC`).all(p.id);
  const events=db.prepare(`SELECT * FROM kyc_events WHERE kyc_profile_id=? ORDER BY created_at DESC`).all(p.id);
  res.json({profile:p,documents:docs,events});
});

app.post('/api/kyc/profile', auth, (req,res)=>{
  const b=req.body||{};
  const existing=kokoKycProfileForUser(req.user.id);
  if(existing){
    db.prepare(`UPDATE kyc_profiles SET entity_type=?,legal_name=?,phone=?,email=?,address=?,id_type=?,id_number_masked=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
      .run(b.entity_type||existing.entity_type,b.legal_name||null,b.phone||null,b.email||null,b.address||null,b.id_type||null,b.id_number_masked||null,req.user.id);
    return res.json({ok:true,profile:kokoKycProfileForUser(req.user.id)});
  }
  const r=db.prepare(`INSERT INTO kyc_profiles(user_id,professional_id,entity_type,legal_name,phone,email,address,id_type,id_number_masked)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.user.id,b.professional_id||null,b.entity_type||'INDIVIDUAL',
      b.legal_name||null,b.phone||null,b.email||null,b.address||null,b.id_type||null,b.id_number_masked||null);
  db.prepare(`INSERT INTO kyc_events(kyc_profile_id,event_type,actor_user_id,note) VALUES(?,?,?,?)`)
    .run(r.lastInsertRowid,'PROFILE_CREATED',req.user.id,'Dossier KYC créé');
  res.json({ok:true,profile:kokoKycProfileForUser(req.user.id)});
});

app.post('/api/kyc/documents', auth, (req,res)=>{
  const p=kokoKycProfileForUser(req.user.id);
  if(!p) return res.status(400).json({error:'Créez d’abord votre profil KYC'});
  const b=req.body||{};
  if(!b.document_type) return res.status(400).json({error:'document_type requis'});
  const r=db.prepare(`INSERT INTO kyc_documents(kyc_profile_id,document_type,document_reference,issued_country,expires_at)
    VALUES(?,?,?,?,?)`).run(p.id,b.document_type,b.document_reference||null,b.issued_country||null,b.expires_at||null);
  db.prepare(`UPDATE kyc_profiles SET verification_status='SUBMITTED',submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(p.id);
  db.prepare(`INSERT INTO kyc_events(kyc_profile_id,event_type,actor_user_id,note) VALUES(?,?,?,?)`)
    .run(p.id,'DOCUMENT_SUBMITTED',req.user.id,b.document_type);
  res.json({ok:true,id:r.lastInsertRowid});
});

app.post('/api/kyc/submit', auth, (req,res)=>{
  const p=kokoKycProfileForUser(req.user.id);
  if(!p) return res.status(400).json({error:'Profil KYC absent'});
  const count=db.prepare(`SELECT COUNT(*) c FROM kyc_documents WHERE kyc_profile_id=?`).get(p.id).c;
  if(count<1) return res.status(400).json({error:'Ajoutez au moins une pièce avant soumission'});
  db.prepare(`UPDATE kyc_profiles SET verification_status='UNDER_REVIEW',submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(p.id);
  db.prepare(`INSERT INTO kyc_events(kyc_profile_id,event_type,actor_user_id,note) VALUES(?,?,?,?)`)
    .run(p.id,'SUBMITTED_FOR_REVIEW',req.user.id,'Dossier soumis au contrôle');
  res.json({ok:true,status:'UNDER_REVIEW'});
});

app.get('/api/admin/kyc', auth, (req,res)=>{
  const status=req.query.status;
  let rows;
  if(status) rows=db.prepare(`SELECT * FROM kyc_profiles WHERE verification_status=? ORDER BY submitted_at DESC`).all(String(status).toUpperCase());
  else rows=db.prepare(`SELECT * FROM kyc_profiles ORDER BY submitted_at DESC`).all();
  res.json(rows);
});

app.get('/api/admin/kyc/:id', auth, (req,res)=>{
  const p=db.prepare(`SELECT * FROM kyc_profiles WHERE id=?`).get(Number(req.params.id));
  if(!p) return res.status(404).json({error:'Dossier KYC introuvable'});
  const docs=db.prepare(`SELECT * FROM kyc_documents WHERE kyc_profile_id=? ORDER BY submitted_at DESC`).all(p.id);
  const events=db.prepare(`SELECT * FROM kyc_events WHERE kyc_profile_id=? ORDER BY created_at DESC`).all(p.id);
  res.json({profile:p,documents:docs,events});
});

app.post('/api/admin/kyc/:id/review', auth, (req,res)=>{
  const id=Number(req.params.id);
  const status=String(req.body.status||'').toUpperCase();
  if(!['VERIFIED','REJECTED','NEEDS_MORE_INFO','SUSPENDED'].includes(status))
    return res.status(400).json({error:'Statut KYC invalide'});
  const days=Number(req.body.validity_days||365);
  const expires=status==='VERIFIED'?new Date(Date.now()+days*86400000).toISOString():null;
  const reason=req.body.reason||null;
  db.prepare(`UPDATE kyc_profiles SET verification_status=?,verification_level=?,verified_at=?,expires_at=?,rejection_reason=?,reviewed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status,status==='VERIFIED'?'VERIFIED':'BASIC',status==='VERIFIED'?new Date().toISOString():null,expires,reason,req.user.id,id);
  db.prepare(`INSERT INTO kyc_events(kyc_profile_id,event_type,actor_user_id,note) VALUES(?,?,?,?)`)
    .run(id,'ADMIN_REVIEW',req.user.id,(status+' '+(reason||'')).trim());
  res.json({ok:true,status,expires_at:expires});
});

app.post('/api/admin/kyc/documents/:id/review', auth, (req,res)=>{
  const id=Number(req.params.id);
  const status=String(req.body.status||'').toUpperCase();
  if(!['ACCEPTED','REJECTED','NEEDS_MORE_INFO'].includes(status))
    return res.status(400).json({error:'Statut document invalide'});
  db.prepare(`UPDATE kyc_documents SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,rejection_reason=? WHERE id=?`)
    .run(status,req.user.id,req.body.reason||null,id);
  res.json({ok:true});
});

app.get('/api/professionals/:id/verification', auth, (req,res)=>{
  const p=db.prepare(`SELECT * FROM kyc_profiles WHERE professional_id=?`).get(Number(req.params.id));
  if(!p) return res.json({status:'NOT_STARTED',verified:false});
  const expired=p.expires_at && new Date(p.expires_at)<new Date();
  res.json({
    status:expired?'EXPIRED':p.verification_status,
    verified:p.verification_status==='VERIFIED' && !expired,
    level:p.verification_level,
    expires_at:p.expires_at
  });
});


// KOKO_V29_CONTRACTS_SCHEMA
db.exec(`
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  quote_id INTEGER NOT NULL,
  client_user_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope_of_work TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'XOF',
  start_date TEXT,
  expected_end_date TEXT,
  cancellation_terms TEXT,
  warranty_terms TEXT,
  payment_terms TEXT,
  client_status TEXT NOT NULL DEFAULT 'PENDING',
  professional_status TEXT NOT NULL DEFAULT 'PENDING',
  contract_status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER NOT NULL DEFAULT 1,
  accepted_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contract_request ON contracts(request_id);
CREATE INDEX IF NOT EXISTS idx_contract_client ON contracts(client_user_id);
CREATE INDEX IF NOT EXISTS idx_contract_pro ON contracts(professional_id);
CREATE INDEX IF NOT EXISTS idx_contract_status ON contracts(contract_status);

CREATE TABLE IF NOT EXISTS contract_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_role TEXT,
  note TEXT,
  snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contract_events_contract ON contract_events(contract_id);
`);


// KOKO_V29_CONTRACTS_ROUTES

function kokoContractForUser(id, userId){
  return db.prepare(`
    SELECT c.*, r.description AS request_description, q.amount AS quote_amount
    FROM contracts c
    LEFT JOIN requests r ON r.id=c.request_id
    LEFT JOIN quotes q ON q.id=c.quote_id
    WHERE c.id=? AND (c.client_user_id=? OR c.professional_id IN (
      SELECT id FROM professionals WHERE user_id=?
    ))`).get(id,userId,userId);
}

app.post('/api/contracts/from-quote/:quoteId', auth, (req,res)=>{
  const quote=db.prepare(`SELECT * FROM quotes WHERE id=?`).get(Number(req.params.quoteId));
  if(!quote) return res.status(404).json({error:'Devis introuvable'});
  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(quote.request_id);
  if(!request) return res.status(404).json({error:'Demande introuvable'});
  if(request.user_id!==req.user.id) return res.status(403).json({error:'Seul le client peut créer le contrat'});
  const requiredLegal=['cgu','confidentialite','paiement','litiges'];
  const missingLegal=requiredLegal.filter(slug=>!hasAcceptedLegal(req.user.id,slug));
  if(missingLegal.length) return res.status(409).json({error:'Acceptation juridique requise avant la création du contrat',missing_legal_documents:missingLegal});
  const professional=db.prepare(`SELECT * FROM professionals WHERE id=?`).get(quote.professional_id);
  if(!professional) return res.status(404).json({error:'Professionnel introuvable'});
  const existing=db.prepare(`SELECT * FROM contracts WHERE quote_id=? AND contract_status NOT IN ('CANCELLED')`).get(quote.id);
  if(existing) return res.json({contract:existing});

  const b=req.body||{};
  const r=db.prepare(`
    INSERT INTO contracts(request_id,quote_id,client_user_id,professional_id,title,scope_of_work,amount,currency,
      start_date,expected_end_date,cancellation_terms,warranty_terms,payment_terms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      request.id,quote.id,req.user.id,quote.professional_id,
      b.title||('Contrat KÔKÔ — Demande #'+request.id),
      b.scope_of_work||request.description||'Prestation selon devis accepté',
      Number(b.amount||quote.amount||0),'XOF',
      b.start_date||null,b.expected_end_date||null,
      b.cancellation_terms||'Annulation selon les conditions convenues entre les parties.',
      b.warranty_terms||'Garantie selon le devis et les conditions convenues.',
      b.payment_terms||'Paiement selon les conditions du devis.'
    );
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note,snapshot)
    VALUES(?,?,?,?,?,?)`).run(r.lastInsertRowid,'CONTRACT_CREATED',req.user.id,'CLIENT','Projet de contrat créé',JSON.stringify(b));
  res.json({ok:true,contract:db.prepare(`SELECT * FROM contracts WHERE id=?`).get(r.lastInsertRowid)});
});

app.get('/api/contracts/:id', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const events=db.prepare(`SELECT * FROM contract_events WHERE contract_id=? ORDER BY created_at ASC`).all(c.id);
  res.json({contract:c,events});
});

app.get('/api/contracts', auth, (req,res)=>{
  const rows=db.prepare(`
    SELECT c.*, r.description AS request_description
    FROM contracts c LEFT JOIN requests r ON r.id=c.request_id
    WHERE c.client_user_id=? OR c.professional_id IN (SELECT id FROM professionals WHERE user_id=?)
    ORDER BY c.created_at DESC`).all(req.user.id,req.user.id);
  res.json(rows);
});

app.put('/api/contracts/:id', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  if(c.contract_status!=='DRAFT') return res.status(400).json({error:'Le contrat n’est plus modifiable'});
  const b=req.body||{};
  db.prepare(`UPDATE contracts SET title=?,scope_of_work=?,amount=?,start_date=?,expected_end_date=?,
    cancellation_terms=?,warranty_terms=?,payment_terms=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.title||c.title,b.scope_of_work||c.scope_of_work,Number(b.amount??c.amount),
      b.start_date??c.start_date,b.expected_end_date??c.expected_end_date,
      b.cancellation_terms??c.cancellation_terms,b.warranty_terms??c.warranty_terms,
      b.payment_terms??c.payment_terms,c.id);
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note)
    VALUES(?,?,?,?,?)`).run(c.id,'CONTRACT_UPDATED',req.user.id,'PARTY','Contrat modifié');
  res.json({ok:true,contract:db.prepare(`SELECT * FROM contracts WHERE id=?`).get(c.id)});
});

function kokoContractParty(c,userId){
  if(c.client_user_id===userId) return 'CLIENT';
  const p=db.prepare(`SELECT id FROM professionals WHERE user_id=?`).get(userId);
  if(p && p.id===c.professional_id) return 'PROFESSIONAL';
  return null;
}

app.post('/api/contracts/:id/accept', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  if(c.contract_status==='CANCELLED') return res.status(400).json({error:'Contrat annulé'});
  const role=kokoContractParty(c,req.user.id);
  if(!role) return res.status(403).json({error:'Accès refusé'});

  if(role==='CLIENT'){
    db.prepare(`UPDATE contracts SET client_status='ACCEPTED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  }else{
    db.prepare(`UPDATE contracts SET professional_status='ACCEPTED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  }
  const updated=db.prepare(`SELECT * FROM contracts WHERE id=?`).get(c.id);
  let activeStatus=updated.contract_status;
  if(updated.client_status==='ACCEPTED' && updated.professional_status==='ACCEPTED'){
    activeStatus='ACTIVE';
    db.prepare(`UPDATE contracts SET contract_status='ACTIVE',accepted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
    try{
      db.prepare(`INSERT INTO notifications(user_id,type,title,body,request_id) VALUES(?,?,?,?,?)`)
        .run(updated.client_user_id,'CONTRACT_ACTIVE','Contrat accepté','Le contrat KÔKÔ est accepté par les deux parties.',updated.request_id);
      const proUser=db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(updated.professional_id);
      if(proUser) db.prepare(`INSERT INTO notifications(user_id,type,title,body,request_id) VALUES(?,?,?,?,?)`)
        .run(proUser.user_id,'CONTRACT_ACTIVE','Contrat accepté','Le contrat KÔKÔ est accepté par les deux parties.',updated.request_id);
    }catch(e){}
  }
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note)
    VALUES(?,?,?,?,?)`).run(c.id,'PARTY_ACCEPTED',req.user.id,role,role+' a accepté le contrat');
  res.json({ok:true,contract:db.prepare(`SELECT * FROM contracts WHERE id=?`).get(c.id),status:activeStatus});
});

app.post('/api/contracts/:id/cancel', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const role=kokoContractParty(c,req.user.id);
  if(!role) return res.status(403).json({error:'Accès refusé'});
  if(c.contract_status==='COMPLETED') return res.status(400).json({error:'Contrat déjà terminé'});
  const reason=req.body?.reason||'Annulation demandée par une partie';
  db.prepare(`UPDATE contracts SET contract_status='CANCELLED',cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note)
    VALUES(?,?,?,?,?)`).run(c.id,'CONTRACT_CANCELLED',req.user.id,role,reason);
  res.json({ok:true});
});

app.post('/api/contracts/:id/complete', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  if(c.client_user_id!==req.user.id) return res.status(403).json({error:'Seul le client peut valider la fin du contrat'});
  if(c.contract_status!=='ACTIVE') return res.status(400).json({error:'Contrat non actif'});
  db.prepare(`UPDATE contracts SET contract_status='COMPLETED',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note)
    VALUES(?,?,?,?,?)`).run(c.id,'CONTRACT_COMPLETED',req.user.id,'CLIENT','Client a validé la fin du contrat');
  res.json({ok:true,status:'COMPLETED'});
});

app.get('/api/admin/contracts', auth, (req,res)=>{
  const status=req.query.status;
  let rows;
  if(status) rows=db.prepare(`SELECT * FROM contracts WHERE contract_status=? ORDER BY created_at DESC`).all(String(status).toUpperCase());
  else rows=db.prepare(`SELECT * FROM contracts ORDER BY created_at DESC`).all();
  res.json(rows);
});




// ================= KÔKÔ V3.3 — DOCUMENTS CONTRACTUELS =================
db.exec(`
CREATE TABLE IF NOT EXISTS contract_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'CONTRACT',
  document_hash TEXT NOT NULL,
  html_content TEXT NOT NULL,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(contract_id) REFERENCES contracts(id)
);
CREATE INDEX IF NOT EXISTS idx_contract_documents_contract ON contract_documents(contract_id);
`);

function htmlEscape(v){
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function getUserName(id){
  const u=db.prepare(`SELECT name,email FROM users WHERE id=?`).get(id);
  return u ? (u.name || u.email || ('Utilisateur #'+id)) : ('Utilisateur #'+id);
}
function buildContractHtml(c){
  const client=getUserName(c.client_user_id);
  const pro=db.prepare(`SELECT p.*,u.name AS user_name,u.email AS user_email FROM professionals p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?`).get(c.professional_id);
  const proName=pro ? (pro.company_name || pro.user_name || pro.user_email || ('Professionnel #'+c.professional_id)) : ('Professionnel #'+c.professional_id);
  const snap=contractSnapshot(c);
  const hash=snapshotHash(snap);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Contrat KÔKÔ #${c.id}</title><style>body{font-family:Arial,sans-serif;max-width:850px;margin:40px auto;padding:0 24px;color:#172033;line-height:1.55}h1{font-size:28px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:6px}.box{background:#f6f7f9;padding:14px;border-radius:8px}.meta{font-size:13px;color:#596273}.sig{display:flex;gap:40px;margin-top:40px}.sig>div{flex:1;border-top:1px solid #333;padding-top:8px}.hash{word-break:break-all;font-family:monospace;font-size:11px}.legal{font-size:11px;color:#606a78;margin-top:35px}</style></head><body><h1>CONTRAT DE PRESTATION — KÔKÔ</h1><p class="meta">Contrat n° ${htmlEscape(c.id)} · Version ${htmlEscape(c.version)} · Côte d’Ivoire · Devise XOF (FCFA)</p><h2>1. Parties</h2><div class="box"><strong>Client :</strong> ${htmlEscape(client)}<br><strong>Professionnel :</strong> ${htmlEscape(proName)}</div><h2>2. Objet de la prestation</h2><p>${htmlEscape(c.scope_of_work)}</p><h2>3. Montant</h2><p><strong>${htmlEscape(c.amount)} ${htmlEscape(c.currency)}</strong></p><h2>4. Calendrier</h2><p>Début prévu : ${htmlEscape(c.start_date || 'À convenir')}<br>Fin prévisionnelle : ${htmlEscape(c.expected_end_date || 'À convenir')}</p><h2>5. Conditions de paiement</h2><p>${htmlEscape(c.payment_terms || 'Selon devis accepté.')}</p><h2>6. Annulation</h2><p>${htmlEscape(c.cancellation_terms || 'Selon conditions convenues entre les parties.')}</p><h2>7. Garantie</h2><p>${htmlEscape(c.warranty_terms || 'Selon devis et conditions convenues.')}</p><h2>8. Acceptation électronique</h2><p>Les parties peuvent accepter électroniquement la présente version. KÔKÔ conserve la version contractuelle, son empreinte numérique et les événements d’acceptation associés.</p><p class="hash"><strong>Empreinte SHA-256 de la version :</strong><br>${hash}</p><div class="sig"><div>Client<br>Acceptation : __________________</div><div>Professionnel<br>Acceptation : __________________</div></div><p class="legal">Document généré par KÔKÔ. Ce document constitue un support contractuel technique et doit être adapté et validé juridiquement avant déploiement commercial. L’intégration d’une signature électronique qualifiée, lorsqu’elle est requise, doit être réalisée via un dispositif/prestataire approprié.</p></body></html>`;
}

app.post('/api/contracts/:id/document/generate', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const hash=saveContractSnapshot(c);
  const html=buildContractHtml(c);
  const r=db.prepare(`INSERT INTO contract_documents(contract_id,contract_version,document_type,document_hash,html_content) VALUES(?,?,?,?,?)`).run(c.id,c.version,'CONTRACT',hash,html);
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note,snapshot) VALUES(?,?,?,?,?,?)`).run(c.id,'CONTRACT_DOCUMENT_GENERATED',req.user.id,kokoContractParty(c,req.user.id)||'PARTY','Document contractuel généré',JSON.stringify({document_id:r.lastInsertRowid,version:c.version,document_hash:hash}));
  res.json({ok:true,document_id:r.lastInsertRowid,contract_id:c.id,contract_version:c.version,document_hash:hash,format:'HTML_PRINTABLE'});
});

app.get('/api/contracts/:id/document', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).send('Contrat introuvable');
  const d=db.prepare(`SELECT * FROM contract_documents WHERE contract_id=? ORDER BY id DESC LIMIT 1`).get(c.id);
  if(!d) return res.status(404).send('Document contractuel non généré');
  res.type('html').send(d.html_content);
});

app.get('/api/contracts/:id/documents', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const rows=db.prepare(`SELECT id,contract_id,contract_version,document_type,document_hash,generated_at FROM contract_documents WHERE contract_id=? ORDER BY id DESC`).all(c.id);
  res.json(rows);
});

// ================= KÔKÔ V3.2 — SIGNATURE & PREUVE ÉLECTRONIQUE =================
// Important: this module records an electronic acceptance/proof trail. It does NOT
// claim to be a qualified electronic signature and must be connected to an appropriate
// certification/signature provider if a qualified signature is legally required.
db.exec(`
CREATE TABLE IF NOT EXISTS contract_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  signer_user_id INTEGER NOT NULL,
  signer_role TEXT NOT NULL,
  signature_type TEXT NOT NULL DEFAULT 'ELECTRONIC_ACCEPTANCE',
  contract_version INTEGER NOT NULL,
  document_hash TEXT NOT NULL,
  signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  declaration TEXT NOT NULL,
  FOREIGN KEY(contract_id) REFERENCES contracts(id),
  FOREIGN KEY(signer_user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS contract_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(contract_id) REFERENCES contracts(id)
);
CREATE INDEX IF NOT EXISTS idx_contract_signatures_contract ON contract_signatures(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_snapshots_contract ON contract_snapshots(contract_id);
`);

function contractSnapshot(c){
  return {
    id:c.id, request_id:c.request_id, quote_id:c.quote_id,
    client_user_id:c.client_user_id, professional_id:c.professional_id,
    title:c.title, scope_of_work:c.scope_of_work, amount:c.amount, currency:c.currency,
    start_date:c.start_date, expected_end_date:c.expected_end_date,
    cancellation_terms:c.cancellation_terms, warranty_terms:c.warranty_terms,
    payment_terms:c.payment_terms, contract_status:c.contract_status,
    client_status:c.client_status, professional_status:c.professional_status,
    version:c.version
  };
}
function snapshotHash(snapshot){
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
function saveContractSnapshot(c){
  const snapshot=contractSnapshot(c);
  const hash=snapshotHash(snapshot);
  const existing=db.prepare(`SELECT id FROM contract_snapshots WHERE contract_id=? AND contract_version=?`).get(c.id,c.version);
  if(!existing) db.prepare(`INSERT INTO contract_snapshots(contract_id,contract_version,snapshot_json,document_hash) VALUES(?,?,?,?)`)
    .run(c.id,c.version,JSON.stringify(snapshot),hash);
  return hash;
}

app.get('/api/contracts/:id/signature-status', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const rows=db.prepare(`SELECT id,signer_user_id,signer_role,signature_type,contract_version,document_hash,signed_at FROM contract_signatures WHERE contract_id=? ORDER BY signed_at ASC`).all(c.id);
  const currentHash=snapshotHash(contractSnapshot(c));
  res.json({contract_id:c.id,contract_version:c.version,current_document_hash:currentHash,signatures:rows,
    client_signed:!!rows.find(x=>x.signer_role==='CLIENT'&&x.contract_version===c.version),
    professional_signed:!!rows.find(x=>x.signer_role==='PROFESSIONAL'&&x.contract_version===c.version),
    proof_level:'ELECTRONIC_ACCEPTANCE_PROOF',
    qualified_signature_integrated:false});
});

app.post('/api/contracts/:id/sign', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  if(c.contract_status==='CANCELLED' || c.contract_status==='COMPLETED') return res.status(400).json({error:'Contrat non signable dans cet état'});
  const role=kokoContractParty(c,req.user.id);
  if(!role) return res.status(403).json({error:'Accès refusé'});
  if(!hasAcceptedLegal(req.user.id,'cgu') || !hasAcceptedLegal(req.user.id,'preuve-electronique'))
    return res.status(409).json({error:'Les documents juridiques requis doivent être acceptés avant la signature électronique.',required:['cgu','preuve-electronique']});
  const declaration=String(req.body?.declaration||'Je confirme mon identité et mon consentement à l’acceptation électronique de ce contrat.').trim();
  if(declaration.length<20) return res.status(400).json({error:'Déclaration de consentement trop courte'});
  const hash=saveContractSnapshot(c);
  const exists=db.prepare(`SELECT id FROM contract_signatures WHERE contract_id=? AND signer_user_id=? AND contract_version=?`).get(c.id,req.user.id,c.version);
  if(exists) return res.json({ok:true,already_signed:true,signature_id:exists.id,document_hash:hash});
  const r=db.prepare(`INSERT INTO contract_signatures(contract_id,signer_user_id,signer_role,signature_type,contract_version,document_hash,declaration) VALUES(?,?,?,?,?,?,?)`)
    .run(c.id,req.user.id,role,'ELECTRONIC_ACCEPTANCE',c.version,hash,declaration);
  db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note,snapshot) VALUES(?,?,?,?,?,?)`)
    .run(c.id,'ELECTRONIC_ACCEPTED',req.user.id,role,'Acceptation électronique enregistrée',JSON.stringify({version:c.version,document_hash:hash,signature_type:'ELECTRONIC_ACCEPTANCE'}));
  res.json({ok:true,signature_id:r.lastInsertRowid,contract_version:c.version,document_hash:hash,
    proof_level:'ELECTRONIC_ACCEPTANCE_PROOF',qualified_signature_integrated:false});
});

app.get('/api/contracts/:id/proof', auth, (req,res)=>{
  const c=kokoContractForUser(Number(req.params.id),req.user.id);
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const snapshot=db.prepare(`SELECT * FROM contract_snapshots WHERE contract_id=? ORDER BY contract_version DESC LIMIT 1`).get(c.id);
  const signatures=db.prepare(`SELECT id,signer_role,signature_type,contract_version,document_hash,signed_at,declaration FROM contract_signatures WHERE contract_id=? ORDER BY signed_at ASC`).all(c.id);
  const currentHash=snapshotHash(contractSnapshot(c));
  res.json({contract:c,snapshot,signatures,current_hash:currentHash,
    integrity_check: snapshot ? snapshot.document_hash===currentHash : false,
    proof_level:'ELECTRONIC_ACCEPTANCE_PROOF',
    notice:'Ce registre constitue une preuve technique d’acceptation électronique. Il ne vaut pas, à lui seul, signature électronique qualifiée.'});
});

app.get('/api/admin/contracts/:id/proof', auth, (req,res)=>{
  if(!['admin','ADMIN'].includes(String(req.user.role))) return res.status(403).json({error:'Accès administrateur requis'});
  const c=db.prepare(`SELECT * FROM contracts WHERE id=?`).get(Number(req.params.id));
  if(!c) return res.status(404).json({error:'Contrat introuvable'});
  const snapshot=db.prepare(`SELECT * FROM contract_snapshots WHERE contract_id=? ORDER BY contract_version DESC LIMIT 1`).get(c.id);
  const signatures=db.prepare(`SELECT id,signer_user_id,signer_role,signature_type,contract_version,document_hash,signed_at,declaration FROM contract_signatures WHERE contract_id=? ORDER BY signed_at ASC`).all(c.id);
  res.json({contract:c,snapshot,signatures});
});



// ================= KÔKÔ V3.4 — DOSSIER DE PRESTATION ADAPTATIF =================
// Les seuils ci-dessous sont des règles produit configurables, pas des seuils légaux.
// Ils servent uniquement à choisir la quantité de traçabilité affichée au client.
db.exec(`
CREATE TABLE IF NOT EXISTS service_dossiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL UNIQUE,
  contract_id INTEGER,
  client_user_id INTEGER NOT NULL,
  professional_id INTEGER,
  level TEXT NOT NULL DEFAULT 'SIMPLE',
  status TEXT NOT NULL DEFAULT 'OPEN',
  title TEXT NOT NULL,
  amount_xof INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(contract_id) REFERENCES contracts(id),
  FOREIGN KEY(client_user_id) REFERENCES users(id),
  FOREIGN KEY(professional_id) REFERENCES professionals(id)
);
CREATE TABLE IF NOT EXISTS service_dossier_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(dossier_id) REFERENCES service_dossiers(id)
);
CREATE TABLE IF NOT EXISTS service_dossier_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  document_type TEXT NOT NULL,
  reference_id INTEGER,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(dossier_id) REFERENCES service_dossiers(id)
);
CREATE INDEX IF NOT EXISTS idx_service_dossier_client ON service_dossiers(client_user_id);
CREATE INDEX IF NOT EXISTS idx_service_dossier_pro ON service_dossiers(professional_id);
CREATE INDEX IF NOT EXISTS idx_service_dossier_level ON service_dossiers(level);
CREATE INDEX IF NOT EXISTS idx_service_dossier_events ON service_dossier_events(dossier_id);
`);

function kokoDossierLevel({amount=0, category='', title='', scope=''}){
  const a=Number(amount||0);
  const text=(`${category} ${title} ${scope}`).toLowerCase();
  const chantierWords=['construction','maçonnerie','étanchéité','renovation','rénovation','carrelage','peinture','menuiserie','climatisation','électricité','plomberie','chantier','toiture','façade'];
  const isBtp=chantierWords.some(w=>text.includes(w));
  // Product thresholds only; configurable later by admin. They are NOT legal thresholds.
  if(isBtp && a>=500000) return 'CHANTIER';
  if(a>=500000) return 'STANDARD';
  if(a>=100000 || isBtp) return 'STANDARD';
  return 'SIMPLE';
}
function kokoDossierForUser(id,userId){
  return db.prepare(`
    SELECT d.*, r.description AS request_description, r.category AS request_category,
      p.name AS professional_name
    FROM service_dossiers d
    LEFT JOIN requests r ON r.id=d.request_id
    LEFT JOIN professionals p ON p.id=d.professional_id
    WHERE d.id=? AND (d.client_user_id=? OR d.professional_id IN (SELECT id FROM professionals WHERE user_id=?))
  `).get(id,userId,userId);
}
function kokoAddDossierDocument(dossierId,type,ref,label){
  const exists=db.prepare(`SELECT id FROM service_dossier_documents WHERE dossier_id=? AND document_type=? AND IFNULL(reference_id,0)=IFNULL(?,0)`).get(dossierId,type,ref||null);
  if(!exists) db.prepare(`INSERT INTO service_dossier_documents(dossier_id,document_type,reference_id,label) VALUES(?,?,?,?)`).run(dossierId,type,ref||null,label);
}

app.post('/api/dossiers/from-request/:requestId', auth, (req,res)=>{
  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(Number(req.params.requestId));
  if(!request) return res.status(404).json({error:'Demande introuvable'});
  if(request.user_id!==req.user.id) return res.status(403).json({error:'Seul le client peut créer le dossier'});
  const existing=db.prepare(`SELECT * FROM service_dossiers WHERE request_id=?`).get(request.id);
  if(existing) return res.json({ok:true,dossier:existing,already_exists:true});
  const quote=db.prepare(`SELECT * FROM quotes WHERE request_id=? AND status='ACCEPTED' ORDER BY id DESC LIMIT 1`).get(request.id);
  const amount=Number(quote?.amount||0);
  const level=kokoDossierLevel({amount,category:request.category,title:request.title||'',scope:request.description||''});
  const professionalId=quote?.professional_id||null;
  const title=request.title||('Dossier KÔKÔ — Demande #'+request.id);
  const r=db.prepare(`INSERT INTO service_dossiers(request_id,contract_id,client_user_id,professional_id,level,status,title,amount_xof) VALUES(?,?,?,?,?,?,?,?)`)
    .run(request.id,null,req.user.id,professionalId,level,'OPEN',title,amount);
  const dossierId=r.lastInsertRowid;
  db.prepare(`INSERT INTO service_dossier_events(dossier_id,event_type,actor_user_id,note,metadata_json) VALUES(?,?,?,?,?)`)
    .run(dossierId,'DOSSIER_CREATED',req.user.id,'Dossier créé automatiquement',JSON.stringify({level,amount_xof:amount,rule:'PRODUCT_RULE'}));
  kokoAddDossierDocument(dossierId,'REQUEST',request.id,'Demande initiale');
  if(quote) kokoAddDossierDocument(dossierId,'QUOTE',quote.id,'Devis accepté');
  res.json({ok:true,dossier:db.prepare(`SELECT * FROM service_dossiers WHERE id=?`).get(dossierId)});
});

app.get('/api/dossiers', auth, (req,res)=>{
  const rows=db.prepare(`SELECT * FROM service_dossiers WHERE client_user_id=? OR professional_id IN (SELECT id FROM professionals WHERE user_id=?) ORDER BY created_at DESC`).all(req.user.id,req.user.id);
  res.json(rows);
});

app.get('/api/dossiers/:id', auth, (req,res)=>{
  const d=kokoDossierForUser(Number(req.params.id),req.user.id);
  if(!d) return res.status(404).json({error:'Dossier introuvable'});
  const events=db.prepare(`SELECT * FROM service_dossier_events WHERE dossier_id=? ORDER BY created_at ASC`).all(d.id);
  const documents=db.prepare(`SELECT * FROM service_dossier_documents WHERE dossier_id=? ORDER BY created_at ASC`).all(d.id);
  const payments=db.prepare(`SELECT * FROM payment_intents WHERE request_id=? ORDER BY created_at ASC`).all(d.request_id);
  const evidence=db.prepare(`SELECT * FROM intervention_evidence WHERE request_id=? ORDER BY created_at ASC`).all(d.request_id);
  const contracts=db.prepare(`SELECT id,version,contract_status,client_status,professional_status,created_at,updated_at FROM contracts WHERE request_id=? ORDER BY id DESC`).all(d.request_id);
  const invoices=db.prepare(`SELECT id,invoice_number,status,total,currency,created_at FROM invoices WHERE request_id=? ORDER BY id DESC`).all(d.request_id);
  res.json({dossier:d,level_rules:{simple:'Petite intervention',standard:'Prestation standard',chantier:'Gros chantier/BTP'},events,documents,payments,evidence,contracts,invoices});
});

app.post('/api/dossiers/:id/refresh', auth, (req,res)=>{
  const d=kokoDossierForUser(Number(req.params.id),req.user.id);
  if(!d) return res.status(404).json({error:'Dossier introuvable'});
  const quote=db.prepare(`SELECT * FROM quotes WHERE request_id=? AND status='ACCEPTED' ORDER BY id DESC LIMIT 1`).get(d.request_id);
  const request=db.prepare(`SELECT * FROM requests WHERE id=?`).get(d.request_id);
  const amount=Number(quote?.amount||d.amount_xof||0);
  const newLevel=kokoDossierLevel({amount,category:request?.category,title:request?.title||d.title,scope:request?.description||''});
  if(newLevel!==d.level){
    db.prepare(`UPDATE service_dossiers SET level=?,amount_xof=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newLevel,amount,d.id);
    db.prepare(`INSERT INTO service_dossier_events(dossier_id,event_type,actor_user_id,note,metadata_json) VALUES(?,?,?,?,?)`).run(d.id,'LEVEL_UPDATED',req.user.id,'Niveau du dossier actualisé',JSON.stringify({from:d.level,to:newLevel,amount_xof:amount,rule:'PRODUCT_RULE'}));
  }
  if(quote) kokoAddDossierDocument(d.id,'QUOTE',quote.id,'Devis accepté');
  const contract=db.prepare(`SELECT * FROM contracts WHERE request_id=? AND contract_status NOT IN ('CANCELLED') ORDER BY id DESC LIMIT 1`).get(d.request_id);
  if(contract){
    db.prepare(`UPDATE service_dossiers SET contract_id=?,professional_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(contract.id,contract.professional_id,d.id);
    kokoAddDossierDocument(d.id,'CONTRACT',contract.id,'Contrat');
  }
  res.json({ok:true,dossier:db.prepare(`SELECT * FROM service_dossiers WHERE id=?`).get(d.id)});
});

app.get('/api/admin/dossiers', auth, (req,res)=>{
  if(!['admin','ADMIN'].includes(String(req.user.role))) return res.status(403).json({error:'Accès administrateur requis'});
  const level=req.query.level?String(req.query.level).toUpperCase():null;
  const rows=level?db.prepare(`SELECT * FROM service_dossiers WHERE level=? ORDER BY created_at DESC`).all(level):db.prepare(`SELECT * FROM service_dossiers ORDER BY created_at DESC`).all();
  res.json(rows);
});



// ============================================================
// KÔKÔ V3.5 — Étapes de chantier & paiements par jalons
// Prototype produit : les paiements réels restent délégués à un
// prestataire de paiement autorisé et les règles contractuelles
// doivent être validées juridiquement avant production.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS service_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  sequence_no INTEGER NOT NULL,
  percentage REAL,
  amount_xof REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  client_validated_at TEXT,
  professional_completed_at TEXT,
  payment_intent_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS milestone_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function kokoMilestoneAccess(milestoneId,userId){
  return db.prepare(`
    SELECT m.*, d.client_user_id, d.professional_id, d.request_id, d.level, d.title AS dossier_title
    FROM service_milestones m
    JOIN service_dossiers d ON d.id=m.dossier_id
    WHERE m.id=? AND (d.client_user_id=? OR d.professional_id IN (SELECT id FROM professionals WHERE user_id=?))
  `).get(milestoneId,userId,userId);
}
function kokoMilestoneEvent(id,type,userId,note,meta={}){
  db.prepare(`INSERT INTO milestone_events(milestone_id,event_type,actor_user_id,note,metadata_json) VALUES(?,?,?,?,?)`)
    .run(id,type,userId,note||null,JSON.stringify(meta));
}

app.post('/api/dossiers/:id/milestones', auth, (req,res)=>{
  const d=kokoDossierForUser(Number(req.params.id),req.user.id);
  if(!d) return res.status(404).json({error:'Dossier introuvable'});
  if(d.level!=='CHANTIER') return res.status(400).json({error:'Les jalons sont réservés au niveau CHANTIER'});
  if(d.professional_id && db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(d.professional_id)?.user_id===req.user.id){
    // allowed
  } else if(d.client_user_id!==req.user.id) return res.status(403).json({error:'Accès refusé'});
  const body=req.body||{};
  const title=String(body.title||'').trim();
  const amount=Number(body.amount_xof||0);
  if(!title || !Number.isFinite(amount) || amount<0) return res.status(400).json({error:'Titre et montant valides requis'});
  const maxSeq=db.prepare(`SELECT COALESCE(MAX(sequence_no),0) AS n FROM service_milestones WHERE dossier_id=?`).get(d.id).n;
  const pct=body.percentage===undefined||body.percentage===null?null:Number(body.percentage);
  const r=db.prepare(`INSERT INTO service_milestones(dossier_id,title,description,sequence_no,percentage,amount_xof,due_date,status) VALUES(?,?,?,?,?,?,?,?)`)
    .run(d.id,title,String(body.description||''),maxSeq+1,(pct!==null&&Number.isFinite(pct))?pct:null,amount,body.due_date||null,'PLANNED');
  kokoMilestoneEvent(r.lastInsertRowid,'MILESTONE_CREATED',req.user.id,'Jalon créé',{amount_xof:amount,percentage:pct});
  res.json({ok:true,milestone:db.prepare(`SELECT * FROM service_milestones WHERE id=?`).get(r.lastInsertRowid)});
});

app.get('/api/dossiers/:id/milestones', auth, (req,res)=>{
  const d=kokoDossierForUser(Number(req.params.id),req.user.id);
  if(!d) return res.status(404).json({error:'Dossier introuvable'});
  const milestones=db.prepare(`SELECT * FROM service_milestones WHERE dossier_id=? ORDER BY sequence_no ASC,id ASC`).all(d.id);
  res.json({dossier_id:d.id,milestones});
});

app.post('/api/milestones/:id/start', auth, (req,res)=>{
  const m=kokoMilestoneAccess(Number(req.params.id),req.user.id);
  if(!m) return res.status(404).json({error:'Jalon introuvable'});
  if(m.status!=='PLANNED') return res.status(400).json({error:'Le jalon ne peut plus être démarré'});
  db.prepare(`UPDATE service_milestones SET status='IN_PROGRESS',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(m.id);
  kokoMilestoneEvent(m.id,'STARTED',req.user.id,'Jalon démarré');
  res.json({ok:true,milestone:db.prepare(`SELECT * FROM service_milestones WHERE id=?`).get(m.id)});
});

app.post('/api/milestones/:id/complete', auth, (req,res)=>{
  const m=kokoMilestoneAccess(Number(req.params.id),req.user.id);
  if(!m) return res.status(404).json({error:'Jalon introuvable'});
  const pro=db.prepare(`SELECT user_id FROM professionals WHERE id=?`).get(m.professional_id);
  if(!pro || pro.user_id!==req.user.id) return res.status(403).json({error:'Seul le professionnel peut déclarer le jalon terminé'});
  if(!['IN_PROGRESS','PLANNED'].includes(m.status)) return res.status(400).json({error:'État du jalon incompatible'});
  db.prepare(`UPDATE service_milestones SET status='AWAITING_CLIENT',professional_completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(m.id);
  kokoMilestoneEvent(m.id,'PROFESSIONAL_COMPLETED',req.user.id,'Jalon déclaré terminé par le professionnel');
  res.json({ok:true,milestone:db.prepare(`SELECT * FROM service_milestones WHERE id=?`).get(m.id)});
});

app.post('/api/milestones/:id/validate', auth, (req,res)=>{
  const m=kokoMilestoneAccess(Number(req.params.id),req.user.id);
  if(!m) return res.status(404).json({error:'Jalon introuvable'});
  if(m.client_user_id!==req.user.id) return res.status(403).json({error:'Seul le client peut valider le jalon'});
  if(m.status!=='AWAITING_CLIENT') return res.status(400).json({error:'Le jalon doit d’abord être déclaré terminé par le professionnel'});
  db.prepare(`UPDATE service_milestones SET status='VALIDATED',client_validated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(m.id);
  kokoMilestoneEvent(m.id,'CLIENT_VALIDATED',req.user.id,'Jalon validé par le client');
  res.json({ok:true,milestone:db.prepare(`SELECT * FROM service_milestones WHERE id=?`).get(m.id)});
});

app.post('/api/milestones/:id/payment-intent', auth, (req,res)=>{
  const m=kokoMilestoneAccess(Number(req.params.id),req.user.id);
  if(!m) return res.status(404).json({error:'Jalon introuvable'});
  if(m.client_user_id!==req.user.id) return res.status(403).json({error:'Seul le client peut initier le paiement'});
  if(!['PLANNED','IN_PROGRESS','AWAITING_CLIENT','VALIDATED'].includes(m.status)) return res.status(400).json({error:'Jalon incompatible avec un paiement'});
  if(Number(m.amount_xof)<=0) return res.status(400).json({error:'Le montant du jalon doit être supérieur à zéro'});
  if(m.payment_intent_id){
    const pi=db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(m.payment_intent_id);
    return res.json({ok:true,payment_intent:pi,already_exists:true});
  }
  const idem=String(req.body?.idempotency_key||`milestone-${m.id}-${Date.now()}`);
  const provider=String(req.body?.provider||'SIMULATOR');
  const method=String(req.body?.method||'SIMULATOR');
  const existing=db.prepare(`SELECT * FROM payment_intents WHERE idempotency_key=?`).get(idem);
  if(existing) return res.json({ok:true,payment_intent:existing,already_exists:true});
  const r=db.prepare(`INSERT INTO payment_intents(request_id,client_user_id,professional_id,amount,currency,purpose,provider,method,status,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(m.request_id,m.client_user_id,m.professional_id,m.amount_xof,'XOF','MILESTONE',provider,method,'CREATED',idem);
  db.prepare(`UPDATE service_milestones SET payment_intent_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(r.lastInsertRowid,m.id);
  kokoMilestoneEvent(m.id,'PAYMENT_INTENT_CREATED',req.user.id,'Intention de paiement créée',{payment_intent_id:r.lastInsertRowid,provider,method});
  res.json({ok:true,payment_intent:db.prepare(`SELECT * FROM payment_intents WHERE id=?`).get(r.lastInsertRowid)});
});

app.get('/api/milestones/:id/events', auth, (req,res)=>{
  const m=kokoMilestoneAccess(Number(req.params.id),req.user.id);
  if(!m) return res.status(404).json({error:'Jalon introuvable'});
  res.json(db.prepare(`SELECT * FROM milestone_events WHERE milestone_id=? ORDER BY created_at ASC,id ASC`).all(m.id));
});


// ============================================================
// KÔKÔ V3.6 — Avenants & modifications de chantier
// Un avenant ne modifie jamais silencieusement le contrat initial.
// Il doit être proposé, accepté par les deux parties, puis appliqué.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS contract_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  dossier_id INTEGER,
  proposed_by_user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope_change TEXT,
  amount_delta_xof REAL NOT NULL DEFAULT 0,
  new_total_xof REAL,
  start_date TEXT,
  expected_end_date TEXT,
  payment_terms TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  client_status TEXT NOT NULL DEFAULT 'PENDING',
  professional_status TEXT NOT NULL DEFAULT 'PENDING',
  version INTEGER NOT NULL DEFAULT 1,
  accepted_at TEXT,
  applied_at TEXT,
  rejected_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contract_amendment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amendment_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  note TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_amendments_contract ON contract_amendments(contract_id);
CREATE INDEX IF NOT EXISTS idx_amendments_dossier ON contract_amendments(dossier_id);
CREATE INDEX IF NOT EXISTS idx_amendment_events ON contract_amendment_events(amendment_id);
`);

function kokoAmendmentAccess(id,userId){
  return db.prepare(`
    SELECT a.*, c.request_id, c.client_user_id, c.professional_id,
      p.user_id AS professional_user_id,
      d.title AS dossier_title
    FROM contract_amendments a
    JOIN contracts c ON c.id=a.contract_id
    LEFT JOIN professionals p ON p.id=c.professional_id
    LEFT JOIN service_dossiers d ON d.id=a.dossier_id
    WHERE a.id=? AND (c.client_user_id=? OR p.user_id=?)
  `).get(id,userId,userId);
}
function kokoAmendmentEvent(id,type,userId,note,extra={}){
  const a=db.prepare(`SELECT * FROM contract_amendments WHERE id=?`).get(id);
  db.prepare(`INSERT INTO contract_amendment_events(amendment_id,event_type,actor_user_id,note,snapshot_json) VALUES(?,?,?,?,?)`)
    .run(id,type,userId,note||null,JSON.stringify({amendment:a||null,...extra}));
}

app.post('/api/contracts/:contractId/amendments', auth, (req,res)=>{
  const contract=db.prepare(`SELECT c.*, p.user_id AS professional_user_id FROM contracts c LEFT JOIN professionals p ON p.id=c.professional_id WHERE c.id=?`).get(Number(req.params.contractId));
  if(!contract) return res.status(404).json({error:'Contrat introuvable'});
  if(![contract.client_user_id,contract.professional_user_id].includes(req.user.id)) return res.status(403).json({error:'Accès refusé'});
  if(['CANCELLED','COMPLETED'].includes(contract.contract_status)) return res.status(400).json({error:'Ce contrat ne peut plus recevoir d’avenant'});
  const b=req.body||{};
  const title=String(b.title||'Modification du chantier').trim();
  const reason=String(b.reason||'').trim();
  if(!reason) return res.status(400).json({error:'Le motif de la modification est obligatoire'});
  const delta=Number(b.amount_delta_xof||0);
  if(!Number.isFinite(delta)) return res.status(400).json({error:'Montant de modification invalide'});
  const newTotal=Number.isFinite(Number(b.new_total_xof))?Number(b.new_total_xof):Number(contract.amount)+delta;
  if(newTotal<0) return res.status(400).json({error:'Le nouveau total ne peut pas être négatif'});
  const dossier=db.prepare(`SELECT id FROM service_dossiers WHERE request_id=?`).get(contract.request_id);
  const r=db.prepare(`INSERT INTO contract_amendments(contract_id,dossier_id,proposed_by_user_id,title,reason,scope_change,amount_delta_xof,new_total_xof,start_date,expected_end_date,payment_terms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contract.id,dossier?.id||null,req.user.id,title,reason,String(b.scope_change||''),delta,newTotal,b.start_date||null,b.expected_end_date||null,b.payment_terms||null);
  kokoAmendmentEvent(r.lastInsertRowid,'AMENDMENT_PROPOSED',req.user.id,'Avenant proposé');
  res.status(201).json({ok:true,amendment:db.prepare(`SELECT * FROM contract_amendments WHERE id=?`).get(r.lastInsertRowid)});
});

app.get('/api/contracts/:contractId/amendments', auth, (req,res)=>{
  const contract=db.prepare(`SELECT c.*, p.user_id AS professional_user_id FROM contracts c LEFT JOIN professionals p ON p.id=c.professional_id WHERE c.id=?`).get(Number(req.params.contractId));
  if(!contract) return res.status(404).json({error:'Contrat introuvable'});
  if(![contract.client_user_id,contract.professional_user_id].includes(req.user.id)) return res.status(403).json({error:'Accès refusé'});
  res.json(db.prepare(`SELECT * FROM contract_amendments WHERE contract_id=? ORDER BY id DESC`).all(contract.id));
});

app.get('/api/amendments/:id', auth, (req,res)=>{
  const a=kokoAmendmentAccess(Number(req.params.id),req.user.id);
  if(!a) return res.status(404).json({error:'Avenant introuvable'});
  const events=db.prepare(`SELECT * FROM contract_amendment_events WHERE amendment_id=? ORDER BY id ASC`).all(a.id);
  res.json({amendment:a,events});
});

app.post('/api/amendments/:id/accept', auth, (req,res)=>{
  const a=kokoAmendmentAccess(Number(req.params.id),req.user.id);
  if(!a) return res.status(404).json({error:'Avenant introuvable'});
  if(a.status!=='PROPOSED') return res.status(400).json({error:'Cet avenant n’est plus en attente d’acceptation'});
  const isClient=a.client_user_id===req.user.id;
  const isPro=a.professional_user_id===req.user.id;
  if(!isClient && !isPro) return res.status(403).json({error:'Accès refusé'});
  const field=isClient?'client_status':'professional_status';
  db.prepare(`UPDATE contract_amendments SET ${field}='ACCEPTED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(a.id);
  kokoAmendmentEvent(a.id,isClient?'CLIENT_ACCEPTED':'PROFESSIONAL_ACCEPTED',req.user.id,'Avenant accepté');
  const updated=db.prepare(`SELECT * FROM contract_amendments WHERE id=?`).get(a.id);
  if(updated.client_status==='ACCEPTED' && updated.professional_status==='ACCEPTED'){
    const contract=db.prepare(`SELECT * FROM contracts WHERE id=?`).get(updated.contract_id);
    if(contract){
      const nextVersion=Number(contract.version||1)+1;
      const before={...contract};
      db.prepare(`UPDATE contracts SET amount=?,scope_of_work=?,start_date=COALESCE(?,start_date),expected_end_date=COALESCE(?,expected_end_date),payment_terms=COALESCE(?,payment_terms),version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(updated.new_total_xof,`${contract.scope_of_work}${updated.scope_change?`\n\n[AVENANT ${nextVersion}] ${updated.scope_change}`:''}`,updated.start_date,updated.expected_end_date,updated.payment_terms,nextVersion,contract.id);
      db.prepare(`UPDATE contract_amendments SET status='APPLIED',version=?,accepted_at=CURRENT_TIMESTAMP,applied_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nextVersion,a.id);
      db.prepare(`INSERT INTO contract_events(contract_id,event_type,actor_user_id,actor_role,note,snapshot) VALUES(?,?,?,?,?,?)`)
        .run(contract.id,'AMENDMENT_APPLIED',req.user.id,'SYSTEM','Avenant accepté par les deux parties et appliqué',JSON.stringify({before,amendment:updated,contract_version:nextVersion}));
      if(updated.dossier_id){
        db.prepare(`UPDATE service_dossiers SET amount_xof=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(updated.new_total_xof,updated.dossier_id);
        db.prepare(`INSERT INTO service_dossier_events(dossier_id,event_type,actor_user_id,note,metadata_json) VALUES(?,?,?,?,?)`)
          .run(updated.dossier_id,'AMENDMENT_APPLIED',req.user.id,'Avenant appliqué au dossier',JSON.stringify({amendment_id:a.id,new_total_xof:updated.new_total_xof,contract_version:nextVersion}));
      }
      kokoAmendmentEvent(a.id,'AMENDMENT_APPLIED',req.user.id,'Avenant appliqué après double acceptation',{contract_version:nextVersion});
    }
  }
  res.json({ok:true,amendment:db.prepare(`SELECT * FROM contract_amendments WHERE id=?`).get(a.id),contract:db.prepare(`SELECT * FROM contracts WHERE id=?`).get(a.contract_id)});
});

app.post('/api/amendments/:id/reject', auth, (req,res)=>{
  const a=kokoAmendmentAccess(Number(req.params.id),req.user.id);
  if(!a) return res.status(404).json({error:'Avenant introuvable'});
  if(a.status!=='PROPOSED') return res.status(400).json({error:'Cet avenant n’est plus modifiable'});
  if(![a.client_user_id,a.professional_user_id].includes(req.user.id)) return res.status(403).json({error:'Accès refusé'});
  const note=String(req.body?.reason||'Avenant refusé').trim();
  db.prepare(`UPDATE contract_amendments SET status='REJECTED',rejected_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(a.id);
  kokoAmendmentEvent(a.id,'AMENDMENT_REJECTED',req.user.id,note);
  res.json({ok:true,amendment:db.prepare(`SELECT * FROM contract_amendments WHERE id=?`).get(a.id)});
});

app.get('/api/dossiers/:id/amendments', auth, (req,res)=>{
  const d=kokoDossierForUser(Number(req.params.id),req.user.id);
  if(!d) return res.status(404).json({error:'Dossier introuvable'});
  res.json(db.prepare(`SELECT a.* FROM contract_amendments a WHERE a.dossier_id=? ORDER BY a.id DESC`).all(d.id));
});
app.get('/',(req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});
app.listen(PORT,()=>console.log(`KÔKÔ API running on http://localhost:${PORT}`));
