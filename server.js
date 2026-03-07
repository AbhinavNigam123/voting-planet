const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================== CONFIG ========================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'panthershow2026';

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
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ======================== JSON-FILE DATABASE ========================
const DB_FILE = path.join(__dirname, 'data.json');

const DEFAULT_DB = {
  state: {
    phase: 'waiting',        // waiting | performing | voting
    currentPerfIndex: 0,
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
  nextShowFeedback: []       // { id, deviceId, feedbackText, anything, ts }
};

// In-memory DB — eliminates race conditions from concurrent file reads/writes
let db = (() => {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('DB read error', e); }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
})();

function loadDB() { return db; }
function saveDB(d) { db = d; fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
function loadPerformances() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'performances.json'), 'utf8')); }

if (!fs.existsSync(DB_FILE)) saveDB(db);

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
  // Keep-alive heartbeat every 15s so proxies don't kill the connection
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e){} }, 15000);
  req.on('close', () => { clearInterval(heartbeat); sseClients = sseClients.filter(c => c !== res); });
});

function parseTime(timeStr) {
  if (!timeStr || timeStr === 'TBA') return Infinity;
  const cleaned = timeStr.replace(/PM|pm|AM|am/gi, '').trim();
  const match = cleaned.match(/(\d+):(\d+)/);
  if (!match) return Infinity;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function getChronologicallySorted(perfs) {
  return [...perfs].sort((a, b) => {
    const timeA = parseTime(a.tentativeTime);
    const timeB = parseTime(b.tentativeTime);
    if (timeA === timeB) return a.order - b.order;
    return timeA - timeB;
  });
}

function buildPublicState(db) {
  const perfs = loadPerformances();
  const sorted = getChronologicallySorted(perfs);
  // Ensure currentPerfIndex is within bounds
  const safeIndex = Math.max(0, Math.min(db.state.currentPerfIndex, sorted.length - 1));
  const cur = sorted[safeIndex] || null;
  return {
    state: { ...db.state, currentPerfIndex: safeIndex },
    currentPerformance: cur,
    currentMedia: cur ? db.media.filter(m => m.performanceId === cur.id).map(m => ({ ...m, url: m.url || `/uploads/${m.filename}` })) : [],
    totalPerformances: sorted.length
  };
}

// ======================== AUTH (device fingerprint) ========================
app.post('/api/auth/join', (req, res) => {
  const { deviceId, firstName, lastName } = req.body;
  if (!deviceId || deviceId.length < 16)
    return res.status(400).json({ error: 'Could not verify your device. Please try again.' });
  if (!firstName || !lastName || !firstName.trim() || !lastName.trim())
    return res.status(400).json({ error: 'First and last name are required.' });
  const db = loadDB();
  if (!db.devices) db.devices = {};
  if (!db.devices[deviceId]) {
    db.devices[deviceId] = { hasVoted: false, firstName: firstName.trim(), lastName: lastName.trim(), ts: Date.now() };
  } else {
    // Update name if already exists (allows re-entry)
    db.devices[deviceId].firstName = firstName.trim();
    db.devices[deviceId].lastName = lastName.trim();
  }
  saveDB(db);
  res.json({ success: true });
});

// ======================== PUBLIC ROUTES ========================
app.get('/api/state', (_req, res) => res.json(buildPublicState(loadDB())));

app.get('/api/performances', (_req, res) => {
  const db = loadDB();
  const perfs = loadPerformances().map(p => ({
    ...p,
    media: (db.media || []).filter(m => m.performanceId === p.id).map(m => ({
      ...m,
      url: m.url || `/uploads/${m.filename}`
    })),
    tentativeTime: p.tentativeTime || '',
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
  res.json({ success: true });
});

// ======================== VOTING ========================
app.post('/api/vote', (req, res) => {
  const { deviceId, rankings, superlativeVotes } = req.body;
  const db = loadDB();
  if (!db.devices) db.devices = {};
  if (!db.state.votingOpen) return res.status(400).json({ error: 'Voting is not open yet.' });
  if (db.devices[deviceId]?.hasVoted) return res.status(400).json({ error: 'You have already voted on this device.' });

  db.votes.push({ id: uuidv4(), deviceId, rankings, ts: Date.now() });

  if (superlativeVotes) {
    Object.entries(superlativeVotes).forEach(([supId, perfId]) => {
      if (perfId) db.superlativeVotes.push({ id: uuidv4(), deviceId, superlativeId: supId, performanceId: Number(perfId) });
    });
  }
  if (!db.devices[deviceId]) db.devices[deviceId] = {};
  db.devices[deviceId].hasVoted = true;
  saveDB(db);
  res.json({ success: true });
});

// ======================== ADMIN ========================
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/admin/phase', adminAuth, (req, res) => {
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
    const perfs = loadPerformances();
    const sorted = getChronologicallySorted(perfs);
    db.state.currentPerfIndex = Math.max(0, Math.min(currentPerfIndex, sorted.length - 1));
  }
  if (feedbackOpen !== undefined)     db.state.feedbackOpen = feedbackOpen;
  if (votingOpen !== undefined)       db.state.votingOpen = votingOpen;
  saveDB(db);
  broadcast('stateUpdate', buildPublicState(db));
  res.json({ success: true, state: db.state });
});

app.post('/api/admin/upload', adminAuth, upload.single('media'), async (req, res) => {
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
      fileUrl = `${process.env.AWS_ENDPOINT_URL_S3}/${process.env.BUCKET_NAME}/${filename}`;
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
  broadcast('mediaUpdate', entry);
  res.json({ success: true, media: entry });
});

app.post('/api/admin/superlative', adminAuth, (req, res) => {
  const db = loadDB();
  const s = { id: uuidv4(), name: req.body.name };
  db.superlatives.push(s);
  saveDB(db);
  res.json({ success: true, superlative: s });
});

app.delete('/api/admin/superlative/:id', adminAuth, (req, res) => {
  const db = loadDB();
  db.superlatives = db.superlatives.filter(s => s.id !== req.params.id);
  db.superlativeVotes = db.superlativeVotes.filter(v => v.superlativeId !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/admin/results', adminAuth, (_req, res) => {
  const db = loadDB();
  const perfs = loadPerformances();
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

  res.json({
    ranked,
    superlatives: supResults,
    feedback: fbByPerf,
    totalVoters: db.votes.length,
    totalFeedback: db.feedback.length,
    nextShowFeedback: db.nextShowFeedback || []
  });
});

// Performance CRUD (permanent, not reset)
app.get('/api/admin/performances', adminAuth, (_req, res) => {
  res.json(loadPerformances());
});

app.post('/api/admin/performance', adminAuth, (req, res) => {
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
    tentativeTime: req.body.tentativeTime || '',
    performerNote: req.body.performerNote || ''
  };
  perfs.push(newPerf);
  fs.writeFileSync(path.join(__dirname, 'performances.json'), JSON.stringify(perfs, null, 2));
  res.json({ success: true, performance: newPerf });
});

app.put('/api/admin/performance/:id', adminAuth, (req, res) => {
  const perfs = loadPerformances();
  const idx = perfs.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Performance not found.' });
  Object.assign(perfs[idx], {
    title: req.body.title ?? perfs[idx].title,
    performers: req.body.performers ?? perfs[idx].performers,
    bio: req.body.bio ?? perfs[idx].bio,
    description: req.body.description ?? perfs[idx].description,
    customQuestion: req.body.customQuestion ?? perfs[idx].customQuestion,
    tentativeTime: req.body.tentativeTime ?? perfs[idx].tentativeTime,
    performerNote: req.body.performerNote ?? perfs[idx].performerNote,
    order: req.body.order !== undefined ? req.body.order : perfs[idx].order
  });
  fs.writeFileSync(path.join(__dirname, 'performances.json'), JSON.stringify(perfs, null, 2));
  broadcast('stateUpdate', buildPublicState(loadDB()));
  res.json({ success: true, performance: perfs[idx] });
});

app.delete('/api/admin/performance/:id', adminAuth, (req, res) => {
  const perfs = loadPerformances();
  const filtered = perfs.filter(p => p.id !== Number(req.params.id));
  if (filtered.length === perfs.length) return res.status(404).json({ error: 'Performance not found.' });
  fs.writeFileSync(path.join(__dirname, 'performances.json'), JSON.stringify(filtered, null, 2));
  const db = loadDB();
  db.media = db.media.filter(m => m.performanceId !== Number(req.params.id));
  db.feedback = db.feedback.filter(f => f.performanceId !== Number(req.params.id));
  db.votes.forEach(v => { delete v.rankings[req.params.id]; });
  db.superlativeVotes = db.superlativeVotes.filter(v => v.performanceId !== Number(req.params.id));
  saveDB(db);
  broadcast('stateUpdate', buildPublicState(db));
  res.json({ success: true });
});

app.delete('/api/admin/media/:id', adminAuth, async (req, res) => {
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
  broadcast('mediaUpdate', { deleted: true, id: req.params.id });
  res.json({ success: true });
});

app.post('/api/admin/reset', adminAuth, (_req, res) => {
  saveDB(JSON.parse(JSON.stringify(DEFAULT_DB)));
  broadcast('stateUpdate', buildPublicState(DEFAULT_DB));
  res.json({ success: true });
});

// ======================== START ========================
app.listen(PORT, () => console.log(`\n  🐾  Panther Creek Talent Show\n  → http://localhost:${PORT}\n`));
