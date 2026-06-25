const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.FLY_MACHINE_ID || `pid-${process.pid}`;

// ======================== CONFIG ========================
if (!process.env.ADMIN_PASSWORD) {
  console.error('\n  ADMIN_PASSWORD environment variable is required.\n  Example: set ADMIN_PASSWORD=your-secret && npm start\n');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ======================== TIGRIS S3 ========================
const USE_S3 = !!(process.env.AWS_ENDPOINT_URL_S3 && process.env.BUCKET_NAME);
let s3 = null;
if (USE_S3) {
  s3 = new S3Client({
    region: process.env.AWS_REGION || 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  });
  console.log('✓ Tigris S3 enabled, bucket:', process.env.BUCKET_NAME);
}

// ======================== MIDDLEWARE ========================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const UPLOADS = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ======================== JSON-FILE DATABASE ========================
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PERFORMANCES_FILE = path.join(DATA_DIR, 'performances.json');

// Seed files from repo on first boot (useful when deploying a locally-built list).
const SEED_DB_FILE = path.join(__dirname, 'data.json');
const SEED_PERFORMANCES_FILE = path.join(__dirname, 'performances.json');
try {
  if (!fs.existsSync(DB_FILE) && fs.existsSync(SEED_DB_FILE)) fs.copyFileSync(SEED_DB_FILE, DB_FILE);
  if (!fs.existsSync(PERFORMANCES_FILE) && fs.existsSync(SEED_PERFORMANCES_FILE)) fs.copyFileSync(SEED_PERFORMANCES_FILE, PERFORMANCES_FILE);
} catch (e) {
  console.error('Seed copy error', e);
}

const DEFAULT_DB = {
  state: {
    phase: 'waiting',        // waiting | performing | voting
    currentPerfIndex: 0,
    currentPerformanceId: null,
    loginEpoch: 0,
    adminOwnerDeviceId: null,
    feedbackOpen: false,
    votingOpen: false
  },
  devices: {},               // deviceId -> { hasVoted, firstName, lastName, ts }
  feedback: [],              // { id, deviceId, performanceId, feedbackText, customAnswer, ts }
  votes: [],                 // { id, deviceId, rankings:{perfId:rank}, ts }
  superlatives: [
    { id: '1', name: 'Most Entertaining' },
    { id: '2', name: 'Best Stage Presence' },
    { id: '3', name: 'Most Creative' }
  ],
  superlativeVotes: [],      // { id, deviceId, superlativeId, performanceId }
  media: [],                 // { id, performanceId, filename, type, ts }
  nextShowFeedback: [],      // { id, deviceId, feedbackText, anything, ts }
  votedTokens: [],           // HTTP-only cookie tokens for voted browsers
  votedHwFingerprints: []    // hardware fingerprints (stable across private browsing)
};

// In-memory DB — eliminates race conditions from concurrent file reads/writes
let db = (() => {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('DB read error', e); }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
})();

let stateVersion = Date.now();
function loadDB() { return db; }
function saveDB(d) { db = d; stateVersion = Date.now(); fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
let performancesCache = (() => {
  try { return JSON.parse(fs.readFileSync(PERFORMANCES_FILE, 'utf8')); }
  catch (e) { console.error('performances read error', e); return []; }
})();
function loadPerformances() { return performancesCache; }
function savePerformances(perfs) {
  performancesCache = perfs;
  stateVersion = Date.now();
  fs.writeFileSync(PERFORMANCES_FILE, JSON.stringify(perfs, null, 2));
}

if (!fs.existsSync(DB_FILE)) saveDB(db);
else {
  const ordered = getOrderedPerformances(loadPerformances());
  normalizeCurrentPerformance(db, ordered);
}

// ======================== MULTER ========================
const multerStorage = USE_S3
  ? multer.memoryStorage()
  : multer.diskStorage({ destination: UPLOADS, filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`) });
const upload = multer({ storage: multerStorage, limits: { fileSize: 150 * 1024 * 1024 } });

// ======================== SSE (live updates) ========================
let sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => r.write(msg));
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('\n');
  sseClients.push(res);
  try {
    res.write(`event: sync\ndata: ${JSON.stringify(buildSyncPayload())}\n\n`);
  } catch (_e) {}
  // Keep-alive heartbeat every 15s so proxies don't kill the connection
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e){} }, 15000);
  req.on('close', () => { clearInterval(heartbeat); sseClients = sseClients.filter(c => c !== res); });
});

function getOrderedPerformances(perfs) {
  return [...perfs].sort((a, b) => (a.order - b.order) || (a.id - b.id));
}

function normalizeCurrentPerformance(dbObj, ordered) {
  if (!dbObj.state) dbObj.state = {};
  if (!ordered.length) {
    dbObj.state.currentPerfIndex = 0;
    dbObj.state.currentPerformanceId = null;
    return null;
  }

  let idx = -1;
  if (dbObj.state.currentPerformanceId != null) {
    idx = ordered.findIndex(p => p.id === Number(dbObj.state.currentPerformanceId));
  }
  if (idx < 0) {
    const safeIndex = Math.max(0, Math.min(Number(dbObj.state.currentPerfIndex || 0), ordered.length - 1));
    idx = safeIndex;
    dbObj.state.currentPerformanceId = ordered[idx].id;
  }
  dbObj.state.currentPerfIndex = idx;
  return ordered[idx];
}

function buildPublicState(db) {
  const perfs = getOrderedPerformances(loadPerformances());
  const cur = normalizeCurrentPerformance(db, perfs);
  return {
    state: { ...db.state },
    currentPerformance: cur,
    currentMedia: cur ? db.media.filter(m => m.performanceId === cur.id).map(m => ({ ...m, url: m.url || `/uploads/${m.filename}` })) : [],
    totalPerformances: perfs.length,
    v: stateVersion
  };
}

function buildSyncPayload() {
  const currentDB = loadDB();
  const publicState = buildPublicState(currentDB);
  const perfs = getOrderedPerformances(loadPerformances()).map(p => ({
    ...p,
    media: (currentDB.media || []).filter(m => m.performanceId === p.id).map(m => ({
      ...m,
      url: m.url || `/uploads/${m.filename}`
    })),
    performerNote: p.performerNote || ''
  }));
  return {
    instanceId: INSTANCE_ID,
    publicState,
    performances: perfs,
    superlatives: currentDB.superlatives || [],
    revision: stateVersion
  };
}

function broadcastSync() {
  broadcast('sync', buildSyncPayload());
}

// ======================== AUTH (device fingerprint) ========================
app.post('/api/auth/join', (req, res) => {
  const { deviceId, firstName, lastName, hwFingerprint } = req.body;
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 20 || !/^[a-zA-Z0-9-]+$/.test(deviceId))
    return res.status(400).json({ error: 'Could not verify your device. Please try again.' });
  if (!firstName || !lastName || !firstName.trim() || !lastName.trim())
    return res.status(400).json({ error: 'First and last name are required.' });
  const db = loadDB();
  if (!db.devices) db.devices = {};
  if (!db.votedTokens) db.votedTokens = [];
  if (!db.votedHwFingerprints) db.votedHwFingerprints = [];

  const cookies = parseCookies(req);
  const hasCookie = !!cookies.pcts_vt;
  const alreadyVotedByCookie = hasCookie && db.votedTokens.includes(cookies.pcts_vt);
  const alreadyVotedByFingerprint = db.devices[deviceId]?.hasVoted === true;
  const alreadyVotedByHw = !!hwFingerprint && db.votedHwFingerprints.includes(hwFingerprint);

  if (!db.devices[deviceId]) {
    db.devices[deviceId] = { hasVoted: alreadyVotedByCookie || alreadyVotedByHw || false, firstName: firstName.trim(), lastName: lastName.trim(), ts: Date.now() };
  } else {
    db.devices[deviceId].firstName = firstName.trim();
    db.devices[deviceId].lastName = lastName.trim();
    if (alreadyVotedByCookie || alreadyVotedByHw) db.devices[deviceId].hasVoted = true;
  }
  saveDB(db);
  res.json({
    success: true,
    loginEpoch: Number(db.state?.loginEpoch || 0),
    alreadyVoted: alreadyVotedByCookie || alreadyVotedByFingerprint || alreadyVotedByHw
  });
});

// ======================== PUBLIC ROUTES ========================
app.get('/api/state', (_req, res) => res.json(buildPublicState(loadDB())));
app.get('/api/sync', (_req, res) => res.json(buildSyncPayload()));

app.get('/api/performances', (_req, res) => {
  const db = loadDB();
  const perfs = getOrderedPerformances(loadPerformances()).map(p => ({
    ...p,
    media: (db.media || []).filter(m => m.performanceId === p.id).map(m => ({
      ...m,
      url: m.url || `/uploads/${m.filename}`
    })),
    performerNote: p.performerNote || ''
  }));
  res.json(perfs);
});

app.get('/api/superlatives', (_req, res) => res.json(loadDB().superlatives));

// ======================== FEEDBACK ========================
app.post('/api/feedback', (req, res) => {
  const { deviceId, performanceId, feedbackText, customAnswer } = req.body;
  const db = loadDB();
  if (db.feedback.find(f => f.deviceId === deviceId && f.performanceId === performanceId))
    return res.status(400).json({ error: 'Already submitted for this performance.' });
  const device = db.devices?.[deviceId];
  db.feedback.push({
    id: uuidv4(),
    deviceId,
    performanceId,
    feedbackText: feedbackText || '',
    customAnswer: customAnswer || '',
    firstName: device?.firstName || 'Unknown',
    lastName: device?.lastName || '',
    ts: Date.now()
  });
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

// Next-year general feedback
app.post('/api/next-feedback', (req, res) => {
  const { deviceId, feedbackText, anything } = req.body;
  const db = loadDB();
  if (!db.nextShowFeedback) db.nextShowFeedback = [];
  if (db.nextShowFeedback.find(f => f.deviceId === deviceId))
    return res.status(400).json({ error: 'You already left overall feedback from this device.' });
  const device = db.devices?.[deviceId];
  db.nextShowFeedback.push({
    id: uuidv4(),
    deviceId,
    feedbackText: feedbackText || '',
    anything: anything || '',
    firstName: device?.firstName || 'Unknown',
    lastName: device?.lastName || '',
    ts: Date.now()
  });
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

// ======================== VOTING ========================
function parseCookies(req) {
  const hdr = req.headers.cookie || '';
  const out = {};
  hdr.split(';').forEach(pair => {
    const [k, ...rest] = pair.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(rest.join('='));
  });
  return out;
}

app.post('/api/vote', (req, res) => {
  const { deviceId, rankings, superlativeVotes, hwFingerprint } = req.body;
  const db = loadDB();
  if (!db.devices) db.devices = {};
  if (!db.votedTokens) db.votedTokens = [];
  if (!db.votedHwFingerprints) db.votedHwFingerprints = [];

  if (!(db.state.votingOpen || db.state.phase === 'voting')) return res.status(400).json({ error: 'Voting is not open yet.' });

  // Layer 1: HTTP-only cookie token
  const cookies = parseCookies(req);
  if (cookies.pcts_vt && db.votedTokens.includes(cookies.pcts_vt)) {
    return res.status(400).json({ error: 'You have already voted on this device.' });
  }

  // Layer 2: Device fingerprint (canvas-based)
  if (db.devices[deviceId]?.hasVoted) return res.status(400).json({ error: 'You have already voted on this device.' });

  // Layer 3: Hardware fingerprint (no canvas — stable across private browsing)
  const hwSeen = !!hwFingerprint && db.votedHwFingerprints.includes(hwFingerprint);
  if (hwSeen) {
    return res.status(400).json({ error: 'A vote has already been cast from this device.' });
  }

  // Layer 4: Name-based duplicate check
  const device = db.devices?.[deviceId];
  const voterNameKey = `${(device?.firstName || '').trim().toLowerCase()}|${(device?.lastName || '').trim().toLowerCase()}`;
  if (voterNameKey !== '|' && db.votes.some(v => v.voterNameKey === voterNameKey)) {
    return res.status(400).json({ error: 'This name has already voted.' });
  }

  const voteToken = uuidv4();
  db.votes.push({
    id: uuidv4(),
    deviceId,
    rankings,
    firstName: device?.firstName || 'Unknown',
    lastName: device?.lastName || '',
    voterNameKey,
    ts: Date.now()
  });

  if (superlativeVotes) {
    Object.entries(superlativeVotes).forEach(([supId, perfId]) => {
      if (perfId) db.superlativeVotes.push({ id: uuidv4(), deviceId, superlativeId: supId, performanceId: Number(perfId) });
    });
  }
  if (!db.devices[deviceId]) db.devices[deviceId] = {};
  db.devices[deviceId].hasVoted = true;
  db.votedTokens.push(voteToken);
  if (hwFingerprint) db.votedHwFingerprints.push(hwFingerprint);
  saveDB(db);
  broadcastSync();

  res.setHeader('Set-Cookie', `pcts_vt=${voteToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
  res.json({ success: true });
});

// ======================== ADMIN ========================
function adminPasswordAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function adminOwnerAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const db = loadDB();
  const reqDeviceId = req.headers['x-admin-device-id'];
  if (!db.state) db.state = {};
  // Auto-claim owner when missing to prevent deadlock after resets/restarts.
  if (!db.state.adminOwnerDeviceId && reqDeviceId) {
    db.state.adminOwnerDeviceId = reqDeviceId;
    saveDB(db);
    broadcastSync();
  }
  const owner = db.state.adminOwnerDeviceId || null;
  if (!owner) return res.status(403).json({ error: 'No active admin owner. Log in again.' });
  if (!reqDeviceId || reqDeviceId !== owner) {
    return res.status(403).json({ error: 'Another device is currently the active admin owner.' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password, deviceId } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  if (!deviceId) return res.status(400).json({ error: 'Missing device ID.' });
  const db = loadDB();
  if (!db.state) db.state = {};
  if (!db.state.adminOwnerDeviceId) {
    db.state.adminOwnerDeviceId = deviceId;
    saveDB(db);
    broadcastSync();
  }
  const isOwner = db.state.adminOwnerDeviceId === deviceId;
  return res.json({ success: true, isOwner, ownerDeviceId: db.state.adminOwnerDeviceId });
});

app.post('/api/admin/release-owner', adminOwnerAuth, (_req, res) => {
  const db = loadDB();
  db.state.adminOwnerDeviceId = null;
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

app.post('/api/admin/phase', adminOwnerAuth, (req, res) => {
  const { phase, currentPerfIndex, feedbackOpen, votingOpen } = req.body;
  const db = loadDB();
  if (phase !== undefined) {
    db.state.phase = phase;
    // Auto-reset conflicting flags when switching phases
    if (phase === 'waiting')    { db.state.votingOpen = false; db.state.feedbackOpen = false; }
    if (phase === 'performing') { db.state.votingOpen = false; }
    if (phase === 'voting')     { db.state.feedbackOpen = false; }
  }
  if (currentPerfIndex !== undefined) {
    const perfs = getOrderedPerformances(loadPerformances());
    const safeIndex = Math.max(0, Math.min(currentPerfIndex, perfs.length - 1));
    db.state.currentPerfIndex = safeIndex;
    db.state.currentPerformanceId = perfs[safeIndex] ? perfs[safeIndex].id : null;
  }
  if (feedbackOpen !== undefined)     db.state.feedbackOpen = feedbackOpen;
  if (votingOpen !== undefined)       db.state.votingOpen = votingOpen;
  saveDB(db);
  broadcastSync();
  res.json({ success: true, state: db.state });
});

app.post('/api/admin/upload', adminOwnerAuth, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const db = loadDB();
  const filename = `${uuidv4()}${path.extname(req.file.originalname)}`;
  let fileUrl;

  if (USE_S3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: filename,
        Body: req.file.buffer,
        ContentType: req.file.mimetype
      }));
      fileUrl = `https://${process.env.BUCKET_NAME}.fly.storage.tigris.dev/${filename}`;
    } catch (e) {
      console.error('S3 upload error', e);
      return res.status(500).json({ error: 'Upload failed.' });
    }
  } else {
    fileUrl = `/uploads/${req.file.filename}`;
  }

  const entry = {
    id: uuidv4(),
    performanceId: Number(req.body.performanceId),
    filename: USE_S3 ? filename : req.file.filename,
    originalName: req.file.originalname,
    type: req.file.mimetype.startsWith('video') ? 'video' : 'image',
    url: fileUrl,
    ts: Date.now()
  };
  db.media.push(entry);
  saveDB(db);
  broadcastSync();
  res.json({ success: true, media: entry });
});

app.post('/api/admin/superlative', adminOwnerAuth, (req, res) => {
  const db = loadDB();
  const s = { id: uuidv4(), name: req.body.name };
  db.superlatives.push(s);
  saveDB(db);
  broadcastSync();
  res.json({ success: true, superlative: s });
});

app.delete('/api/admin/superlative/:id', adminOwnerAuth, (req, res) => {
  const db = loadDB();
  db.superlatives = db.superlatives.filter(s => s.id !== req.params.id);
  db.superlativeVotes = db.superlativeVotes.filter(v => v.superlativeId !== req.params.id);
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

app.get('/api/admin/results', adminPasswordAuth, (_req, res) => {
  const db = loadDB();
  const perfs = getOrderedPerformances(loadPerformances());
  const pts = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };
  const scores = {};
  perfs.forEach(p => { scores[p.id] = 0; });
  db.votes.forEach(v => {
    Object.entries(v.rankings).forEach(([pid, rank]) => {
      scores[Number(pid)] = (scores[Number(pid)] || 0) + (pts[rank] || 0);
    });
  });
  const ranked = perfs.map(p => ({ ...p, score: scores[p.id] || 0, media: db.media.filter(m => m.performanceId === p.id) }))
    .sort((a, b) => b.score - a.score);

  const supResults = db.superlatives.map(sup => {
    const counts = {};
    db.superlativeVotes.filter(v => v.superlativeId === sup.id).forEach(v => { counts[v.performanceId] = (counts[v.performanceId] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { ...sup, winner: top ? perfs.find(p => p.id === Number(top[0])) : null, winnerVotes: top ? top[1] : 0 };
  });

  const fbByPerf = {};
  db.feedback.forEach(f => { (fbByPerf[f.performanceId] = fbByPerf[f.performanceId] || []).push(f); });

  const voters = (db.votes || []).map(v => {
    const firstName = v.firstName || db.devices?.[v.deviceId]?.firstName || 'Unknown';
    const lastName = v.lastName || db.devices?.[v.deviceId]?.lastName || '';
    const perfFeedback = (db.feedback || [])
      .filter(f => f.deviceId === v.deviceId)
      .map(f => {
        const perf = perfs.find(p => p.id === Number(f.performanceId));
        return {
          performanceTitle: perf ? perf.title : `Performance ${f.performanceId}`,
          feedbackText: f.feedbackText || '',
          customAnswer: f.customAnswer || ''
        };
      });
    const next = (db.nextShowFeedback || []).find(n => n.deviceId === v.deviceId);
    return {
      firstName,
      lastName,
      perfFeedback,
      nextFeedback: next?.feedbackText || '',
      anything: next?.anything || ''
    };
  });

  res.json({
    ranked,
    superlatives: supResults,
    feedback: fbByPerf,
    voters,
    totalVoters: db.votes.length,
    totalFeedback: db.feedback.length,
    nextShowFeedback: db.nextShowFeedback || []
  });
});

// Performance CRUD (permanent, not reset)
app.get('/api/admin/performances', adminOwnerAuth, (_req, res) => {
  res.json(getOrderedPerformances(loadPerformances()));
});

app.post('/api/admin/performance', adminOwnerAuth, (req, res) => {
  const perfs = loadPerformances();
  const maxId = Math.max(...perfs.map(p => p.id), 0);
  const maxOrder = Math.max(...perfs.map(p => p.order), 0);
  const newPerf = {
    id: maxId + 1,
    order: maxOrder + 1,
    title: req.body.title || 'Untitled',
    performers: req.body.performers || '',
    bio: req.body.bio || '',
    description: req.body.description || '',
    customQuestion: req.body.customQuestion || '',
    performerNote: req.body.performerNote || ''
  };
  perfs.push(newPerf);
  savePerformances(perfs);
  const db = loadDB();
  normalizeCurrentPerformance(db, getOrderedPerformances(perfs));
  saveDB(db);
  broadcastSync();
  res.json({ success: true, performance: newPerf });
});

app.put('/api/admin/performance/:id', adminOwnerAuth, (req, res) => {
  const perfs = loadPerformances();
  const idx = perfs.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Performance not found.' });
  Object.assign(perfs[idx], {
    title: req.body.title ?? perfs[idx].title,
    performers: req.body.performers ?? perfs[idx].performers,
    bio: req.body.bio ?? perfs[idx].bio,
    description: req.body.description ?? perfs[idx].description,
    customQuestion: req.body.customQuestion ?? perfs[idx].customQuestion,
    performerNote: req.body.performerNote ?? perfs[idx].performerNote,
    order: req.body.order !== undefined ? req.body.order : perfs[idx].order
  });
  savePerformances(perfs);
  const db = loadDB();
  normalizeCurrentPerformance(db, getOrderedPerformances(perfs));
  saveDB(db);
  broadcastSync();
  res.json({ success: true, performance: perfs[idx] });
});

app.post('/api/admin/performance/reorder', adminOwnerAuth, (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    return res.status(400).json({ error: 'orderedIds is required.' });
  }
  const perfs = loadPerformances();
  const idSet = new Set(perfs.map(p => p.id));
  const validIds = orderedIds.map(Number).filter(id => idSet.has(id));
  if (!validIds.length) return res.status(400).json({ error: 'No valid performance IDs provided.' });
  const orderMap = new Map();
  validIds.forEach((id, index) => orderMap.set(id, index + 1));
  const untouched = getOrderedPerformances(perfs).filter(p => !orderMap.has(p.id));
  let nextOrder = validIds.length + 1;
  untouched.forEach(p => orderMap.set(p.id, nextOrder++));
  perfs.forEach(p => { p.order = orderMap.get(p.id) || p.order; });
  savePerformances(perfs);
  const db = loadDB();
  normalizeCurrentPerformance(db, getOrderedPerformances(perfs));
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

app.delete('/api/admin/performance/:id', adminOwnerAuth, (req, res) => {
  const perfs = loadPerformances();
  const filtered = perfs.filter(p => p.id !== Number(req.params.id));
  if (filtered.length === perfs.length) return res.status(404).json({ error: 'Performance not found.' });
  const orderedFiltered = getOrderedPerformances(filtered).map((p, i) => ({ ...p, order: i + 1 }));
  savePerformances(orderedFiltered);
  const db = loadDB();
  db.media = db.media.filter(m => m.performanceId !== Number(req.params.id));
  db.feedback = db.feedback.filter(f => f.performanceId !== Number(req.params.id));
  db.votes.forEach(v => { delete v.rankings[req.params.id]; });
  db.superlativeVotes = db.superlativeVotes.filter(v => v.performanceId !== Number(req.params.id));
  normalizeCurrentPerformance(db, orderedFiltered);
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

app.delete('/api/admin/media/:id', adminOwnerAuth, async (req, res) => {
  const db = loadDB();
  const media = db.media.find(m => m.id === req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found.' });
  if (USE_S3) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: media.filename })); } catch(e) { console.error('S3 delete error', e); }
  } else {
    const filePath = path.join(UPLOADS, media.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.media = db.media.filter(m => m.id !== req.params.id);
  saveDB(db);
  broadcastSync();
  res.json({ success: true });
});

const CLEAR_VOTE_COOKIE = 'pcts_vt=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

app.post('/api/admin/reset', adminPasswordAuth, (req, res) => {
  const current = loadDB();
  const fresh = JSON.parse(JSON.stringify(DEFAULT_DB));
  fresh.state.loginEpoch = Number(current.state?.loginEpoch || 0);
  const reqDeviceId = req.headers['x-admin-device-id'];
  fresh.state.adminOwnerDeviceId = reqDeviceId || current.state?.adminOwnerDeviceId || null;
  const ordered = getOrderedPerformances(loadPerformances());
  if (ordered.length) {
    fresh.state.currentPerformanceId = ordered[0].id;
    fresh.state.currentPerfIndex = 0;
  }
  saveDB(fresh);
  broadcast('reset', { complete: false });
  broadcastSync();
  res.setHeader('Set-Cookie', CLEAR_VOTE_COOKIE);
  res.json({ success: true });
});

app.post('/api/admin/reset-complete', adminPasswordAuth, (_req, res) => {
  const currentEpoch = Number(loadDB().state?.loginEpoch || 0);
  const fresh = JSON.parse(JSON.stringify(DEFAULT_DB));
  fresh.state.loginEpoch = currentEpoch + 1;
  const ordered = getOrderedPerformances(loadPerformances());
  if (ordered.length) {
    fresh.state.currentPerformanceId = ordered[0].id;
    fresh.state.currentPerfIndex = 0;
  }
  saveDB(fresh);
  broadcast('reset', { complete: true });
  broadcastSync();
  res.setHeader('Set-Cookie', CLEAR_VOTE_COOKIE);
  res.json({ success: true });
});

// ======================== START ========================
app.listen(PORT, () => console.log(`\n  🐾  Panther Creek Talent Show\n  → http://localhost:${PORT}\n`));
