/* ========================================================
   Panther Creek Talent Show — Client
   ======================================================== */

// ─── State ──────────────────────────────────────────────
let deviceId = null;      // fingerprint-based device ID
let hwFingerprint = null; // hardware-only fingerprint (stable across private browsing)
let isAdmin = false;
let isAdminOwner = false;
let adminPW = '';
let appState = null;
let performances = [];
let superlatives = [];
let feedbackDone = {};
let lastSyncRevision = -1;
let voteDraft = { rankings: {}, superlativeVotes: {} };

function forceLogoutToLogin() {
  localStorage.removeItem('pcts_voted');
  localStorage.removeItem('pcts_joined');
  localStorage.removeItem('pcts_did');
  localStorage.removeItem('pcts_firstName');
  localStorage.removeItem('pcts_lastName');
  localStorage.removeItem('pcts_admin');
  localStorage.removeItem('pcts_pw');
  localStorage.removeItem('pcts_login_epoch');
  localStorage.removeItem('pcts_admin_owner');
  localStorage.removeItem('pcts_vote_draft');
  isAdmin = false;
  isAdminOwner = false;
  adminPW = '';
}

// ─── Helpers ────────────────────────────────────────────
const $ = s => document.getElementById(s);
const hide = id => $(id).classList.add('hidden');
const show = id => $(id).classList.remove('hidden');
function hideAll(sel){ document.querySelectorAll(sel).forEach(e=>e.classList.add('hidden')); }

async function api(url, opts = {}) {
  if (adminPW && !opts.headers) opts.headers = {};
  if (adminPW && opts.headers) opts.headers['x-admin-password'] = adminPW;
  if (deviceId) {
    opts.headers = opts.headers || {};
    opts.headers['x-admin-device-id'] = deviceId;
  }
  if (opts.cache === undefined) opts.cache = 'no-store';
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
  return r.json();
}

function withNoCacheQuery(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_t=${Date.now()}`;
}

// ─── Device Fingerprint ─────────────────────────────────
function getGLInfo() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!gl) return { vendor: '', renderer: '' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '',
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''
  };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateFingerprint() {
  const canvas = document.createElement('canvas');
  canvas.width = 220; canvas.height = 40;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#002D62'; ctx.fillText('PantherCreekTalentShow', 4, 2);
    ctx.fillStyle = 'rgba(91,164,207,0.7)'; ctx.fillRect(90, 10, 80, 20);
  }
  const { vendor, renderer } = getGLInfo();
  const raw = [
    navigator.userAgent || '', navigator.platform || '', navigator.language || '',
    String(new Date().getTimezoneOffset()), String(screen.width || 0), String(screen.height || 0),
    String(screen.colorDepth || 0), String(navigator.hardwareConcurrency || 0),
    String(navigator.deviceMemory || 0), String(navigator.maxTouchPoints || 0),
    vendor, renderer, canvas.toDataURL()
  ].join('|');
  return sha256Hex(raw);
}

async function generateHardwareFingerprint() {
  const { vendor, renderer } = getGLInfo();
  const raw = [
    navigator.userAgent || '', navigator.platform || '', navigator.language || '',
    String(new Date().getTimezoneOffset()), String(screen.width || 0), String(screen.height || 0),
    String(screen.colorDepth || 0), String(navigator.hardwareConcurrency || 0),
    String(navigator.deviceMemory || 0), String(navigator.maxTouchPoints || 0),
    String(window.devicePixelRatio || 1), vendor, renderer
  ].join('|');
  return sha256Hex(raw);
}

function applySyncPayload(payload) {
  if (!payload || !payload.publicState) return;
  const incomingRevision = Number(payload.revision ?? payload.publicState.v ?? -1);
  if (incomingRevision > 0 && lastSyncRevision > 0 && incomingRevision < lastSyncRevision) {
    return;
  }
  appState = payload.publicState;
  performances = payload.performances || [];
  superlatives = payload.superlatives || [];
  if (incomingRevision > 0) lastSyncRevision = incomingRevision;
}

// ─── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  isAdmin = localStorage.getItem('pcts_admin') === '1';
  isAdminOwner = localStorage.getItem('pcts_admin_owner') === '1';
  adminPW = localStorage.getItem('pcts_pw') || '';
  try { voteDraft = JSON.parse(localStorage.getItem('pcts_vote_draft') || '{"rankings":{},"superlativeVotes":{}}'); } catch(_e) {}

  // Generate or reuse fingerprint
  deviceId = localStorage.getItem('pcts_did');
  if (!deviceId || !/^[a-f0-9]{64}$/.test(deviceId)) {
    deviceId = await generateFingerprint();
    localStorage.setItem('pcts_did', deviceId);
  }
  hwFingerprint = await generateHardwareFingerprint();

  // If already joined, skip welcome screen
  if (localStorage.getItem('pcts_joined') === '1') enterApp();

  $('admin-pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') loginAdmin(); });
  $('first-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('last-name').focus(); });
  $('last-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinShow(); });
});

// ─── Auth (Join) ────────────────────────────────────────
async function joinShow() {
  const firstName = ($('first-name')?.value || '').trim();
  const lastName = ($('last-name')?.value || '').trim();
  $('auth-error').textContent = '';
  if (!firstName || !lastName) {
    $('auth-error').textContent = 'Please enter both your first and last name.';
    return;
  }
  const d = await api('/api/auth/join', { method: 'POST', body: { deviceId, firstName, lastName, hwFingerprint } });
  if (d.error) { $('auth-error').textContent = d.error; return; }
  localStorage.setItem('pcts_joined', '1');
  localStorage.setItem('pcts_firstName', firstName);
  localStorage.setItem('pcts_lastName', lastName);
  localStorage.setItem('pcts_login_epoch', String(Number(d.loginEpoch || 0)));
  if (d.alreadyVoted) localStorage.setItem('pcts_voted', '1');
  enterApp();
}

async function enterApp() {
  hide('auth-screen'); show('app');
  if (isAdmin) $('admin-trigger').classList.add('active');
  await loadSync();
  connectSSE();
  render();
  // Re-sync when user returns to tab
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try { await loadSync(); render(); if (isAdmin) refreshAdminPanel(); } catch(e) {}
    }
  });
  // Polling fallback — catches any missed SSE events
  setInterval(async () => {
    try {
      const fresh = await api(withNoCacheQuery('/api/sync'));
      if (fresh && fresh.revision !== undefined && Number(fresh.revision) !== lastSyncRevision) {
        applySyncPayload(fresh);
        render();
        if (isAdmin) refreshAdminPanel();
      }
    } catch(e) {}
  }, 5000);
}

// ─── SSE ────────────────────────────────────────────────
let _es = null;
function connectSSE() {
  if (_es) { _es.close(); _es = null; }
  _es = new EventSource('/api/events');
  _es.addEventListener('sync', e => {
    const payload = JSON.parse(e.data);
    const prev = appState;
    applySyncPayload(payload);
    if (prev && prev.state.votingOpen && !appState.state.votingOpen) {
      localStorage.removeItem('pcts_voted');
      voteDraft = { rankings: {}, superlativeVotes: {} };
      localStorage.removeItem('pcts_vote_draft');
      feedbackDone = {};
    }
    render();
    if (isAdmin) refreshAdminPanel();
  });
  _es.addEventListener('reset', e => {
    const d = e.data ? JSON.parse(e.data) : {};
    if (d.complete) {
      forceLogoutToLogin();
      feedbackDone = {};
      location.reload();
      return;
    }
    // Non-complete reset should not log everyone out.
    localStorage.removeItem('pcts_voted');
    voteDraft = { rankings: {}, superlativeVotes: {} };
    localStorage.removeItem('pcts_vote_draft');
    feedbackDone = {};
    loadSync().then(() => {
      render();
      if (isAdmin) refreshAdminPanel();
    }).catch(() => {});
  });
  _es.onerror = () => {
    if (_es) _es.close();
    _es = null;
    setTimeout(connectSSE, 2000);
  };
}

async function loadSync() {
  const payload = await api(withNoCacheQuery('/api/sync'));
  applySyncPayload(payload);
}

async function loadState() {
  const fresh = await api('/api/state');
  if (!appState) appState = fresh;
  else appState = fresh;
}

async function loadPerfs() {
  const perfs = await api('/api/performances');
  if (Array.isArray(perfs)) performances = perfs;
  if (appState && appState.state.phase === 'waiting') renderProgram();
}

async function loadSups()  {
  const sups = await api('/api/superlatives');
  if (Array.isArray(sups)) superlatives = sups;
}

// ─── Render ─────────────────────────────────────────────
function render() {
  if (!appState) return;
  hideAll('.screen');
  const s = appState.state;
  if (s.votingOpen) {
    if (localStorage.getItem('pcts_voted') === '1') { show('scr-voted'); return; }
    renderVoting(); show('scr-voting'); return;
  }
  if (s.phase === 'waiting') { renderProgram(); show('scr-waiting'); return; }
  if (s.phase === 'performing') { renderPerformance(); show('scr-performing'); return; }
}

function renderPerformance() {
  const p = appState.currentPerformance;
  if (!p) return;
  const orderPos = getOrderedPosition(p.id);
  $('perf-num').textContent = orderPos || appState.state.currentPerfIndex + 1;
  $('perf-total').textContent = appState.totalPerformances;
  $('perf-title').textContent = p.title;
  $('perf-performers').textContent = p.performers;
  $('perf-bio').textContent = p.bio || '';
  $('perf-desc').textContent = p.description || '';
  $('perf-bio').style.display = p.bio ? '' : 'none';
  $('perf-desc').style.display = p.description ? '' : 'none';
  $('perf-desc-label').style.display = p.description ? '' : 'none';
  if (p.performerNote) {
    $('perf-note').textContent = p.performerNote;
    $('perf-note-label').style.display = '';
    $('perf-note').style.display = '';
  } else {
    $('perf-note-label').style.display = 'none';
    $('perf-note').style.display = 'none';
  }
  renderCurrentMedia();

  const done = feedbackDone[p.id];
  if (appState.state.feedbackOpen && !done) {
    show('feedback-section'); hide('fb-done');
    if (p.customQuestion) { $('custom-q-label').textContent = p.customQuestion; show('custom-q-wrap'); }
    else hide('custom-q-wrap');
    $('fb-status').textContent = '';
    $('feedback-input').value = '';
    $('custom-q-input').value = '';
  } else if (done) { hide('feedback-section'); show('fb-done'); }
  else { hide('feedback-section'); hide('fb-done'); }
}

function mediaUrl(m) { return m.url || `/uploads/${m.filename}`; }

function renderCurrentMedia() {
  const media = appState.currentMedia || [];
  $('perf-media').innerHTML = media.map(m =>
    m.type === 'video'
      ? `<video src="${mediaUrl(m)}" controls playsinline preload="metadata" style="max-width:100%"></video>`
      : `<img src="${mediaUrl(m)}" alt="clip" loading="lazy">`
  ).join('');
}

function renderMedia() {
  if (appState && appState.state.phase === 'performing') renderCurrentMedia();
}

function getOrderedPerformances() {
  return [...performances].sort((a, b) => {
    if (a.order === b.order) return a.id - b.id;
    return a.order - b.order;
  });
}

function getOrderedPosition(perfId) {
  const sorted = getOrderedPerformances();
  const index = sorted.findIndex(p => p.id === perfId);
  return index >= 0 ? index + 1 : null;
}

function renderProgram() {
  const sorted = getOrderedPerformances();
  const out = [];
  sorted.forEach((p, idx) => {
    if (idx === 12) {
      out.push(`<div class="prog-intermission"><span>Intermission</span><small>Take a quick break</small></div>`);
    }
    out.push(
      `<div class="prog-item">
        <div class="prog-num">${idx + 1}</div>
        <div class="prog-info">
          <div class="prog-title">${esc(p.title)}</div>
          <div class="prog-performers">${esc(p.performers)}</div>
          <div class="prog-desc">${esc(p.description || '')}</div>
        </div>
      </div>`
    );
  });
  const html = out.join('');
  $('program-list').innerHTML = html;
  $('program-modal-list').innerHTML = html;
}

function toggleProgramModal() {
  const modal = $('program-modal');
  if (modal.classList.contains('hidden')) {
    renderProgram();
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

// ─── Feedback ───────────────────────────────────────────
async function submitFeedback() {
  const p = appState.currentPerformance;
  if (!p) return;
  $('fb-status').textContent = '';
  const d = await api('/api/feedback', {
    method: 'POST',
    body: { deviceId, performanceId: p.id, feedbackText: $('feedback-input').value.trim(), customAnswer: $('custom-q-input').value.trim() }
  });
  if (d.error) { $('fb-status').textContent = d.error; $('fb-status').style.color = '#dc2626'; return; }
  feedbackDone[p.id] = true;
  hide('feedback-section'); show('fb-done');
}

// ─── Voting ─────────────────────────────────────────────
function renderVoting() {
  const sorted = getOrderedPerformances();
  const html = sorted.map((p, idx) => {
    const media = (p.media && p.media.length) ? `<div class="vc-media">${mediaThumb(p.media[0])}</div>` : '';
    const opts = '<option value="">—</option>' + [1,2,3,4,5].map(n => `<option value="${n}">Rank ${n}</option>`).join('');
    return `<div class="vote-card" data-pid="${p.id}">
      ${media}
      <div class="vc-info">
        <div class="vc-title">#${idx + 1} - ${esc(p.title)}</div>
        <div class="vc-name">${esc(p.performers)}</div>
        <select class="field rank-sel" data-pid="${p.id}" style="width:auto;margin-top:.4rem">${opts}</select>
      </div>
    </div>`;
  }).join('');
  $('vote-cards').innerHTML = html;
  document.querySelectorAll('.rank-sel').forEach(sel => {
    const v = voteDraft.rankings?.[sel.dataset.pid];
    if (v && Array.from(sel.options).some(o => o.value === String(v))) sel.value = String(v);
  });
  
  // Add change listeners to update dropdowns dynamically
  document.querySelectorAll('.rank-sel').forEach(sel => {
    sel.addEventListener('change', updateVotingDropdowns);
  });

  const sortedForOpts = getOrderedPerformances();
  const perfOpts = '<option value="">— Select —</option>' +
    sortedForOpts.map((p, idx) => `<option value="${p.id}">#${idx + 1} - ${esc(p.title)}</option>`).join('');
  $('sup-votes').innerHTML = superlatives.map(s =>
    `<div class="sup-row"><span class="sup-name">${esc(s.name)}</span>
     <select class="field sup-sel" data-sid="${s.id}" style="width:auto">${perfOpts}</select></div>`
  ).join('');
  document.querySelectorAll('.sup-sel').forEach(sel => {
    const v = voteDraft.superlativeVotes?.[sel.dataset.sid];
    if (v && Array.from(sel.options).some(o => o.value === String(v))) sel.value = String(v);
    sel.addEventListener('change', () => {
      voteDraft.superlativeVotes[sel.dataset.sid] = sel.value || '';
      localStorage.setItem('pcts_vote_draft', JSON.stringify(voteDraft));
    });
  });
  
  updateVotingProgress();
  updateVotingDropdowns();
}

function updateVotingDropdowns() {
  const selected = new Map();
  document.querySelectorAll('.rank-sel').forEach(sel => {
    if (sel.value) selected.set(sel.value, sel.dataset.pid);
  });
  
  document.querySelectorAll('.rank-sel').forEach(sel => {
    const currentVal = sel.value;
    const currentPid = sel.dataset.pid;
    const available = [1,2,3,4,5].filter(r => {
      const pid = selected.get(String(r));
      return !pid || pid === currentPid;
    });
    
    const opts = '<option value="">—</option>' + available.map(n => 
      `<option value="${n}" ${currentVal === String(n) ? 'selected' : ''}>Rank ${n}</option>`
    ).join('');
    sel.innerHTML = opts;
    
    // Update card styling
    const card = sel.closest('.vote-card');
    if (sel.value) card.classList.add('ranked');
    else card.classList.remove('ranked');
  });
  
  updateVotingProgress();
  voteDraft.rankings = {};
  document.querySelectorAll('.rank-sel').forEach(sel => {
    if (sel.value) voteDraft.rankings[sel.dataset.pid] = Number(sel.value);
  });
  localStorage.setItem('pcts_vote_draft', JSON.stringify(voteDraft));
}

function updateVotingProgress() {
  const selected = Array.from(document.querySelectorAll('.rank-sel')).filter(s => s.value).length;
  const pct = (selected / 5) * 100;
  $('vote-progress-bar').style.width = pct + '%';
  $('vote-count').textContent = `${selected} of 5 performances ranked`;
}

function mediaThumb(m) {
  const src = mediaUrl(m);
  if (m.type === 'video') {
    return `<video src="${src}" controls playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>`;
  }
  return `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover">`;
}

async function submitVotes() {
  $('vote-status').textContent = '';
  const rankings = {};
  let valid = true;
  const used = new Set();
  document.querySelectorAll('.rank-sel').forEach(sel => {
    const v = sel.value;
    if (v) { if (used.has(v)) valid = false; used.add(v); rankings[sel.dataset.pid] = Number(v); }
  });
  if (!valid) { $('vote-status').textContent = 'Each rank (1-5) can only be used once!'; $('vote-status').style.color='#dc2626'; return; }
  if (used.size < 1) { $('vote-status').textContent = 'Please rank at least one performance.'; $('vote-status').style.color='#dc2626'; return; }

  const superlativeVotes = {};
  document.querySelectorAll('.sup-sel').forEach(sel => { if (sel.value) superlativeVotes[sel.dataset.sid] = sel.value; });

  const d = await api('/api/vote', { method: 'POST', body: { deviceId, rankings, superlativeVotes, hwFingerprint } });
  if (d.error) {
    $('vote-status').textContent = d.error;
    $('vote-status').style.color='#dc2626';
    if (d.error.includes('not open') || d.error.includes('already voted')) {
      try { await loadSync(); render(); } catch(e) {}
    }
    return;
  }
  localStorage.setItem('pcts_voted', '1');
  voteDraft = { rankings: {}, superlativeVotes: {} };
  localStorage.removeItem('pcts_vote_draft');
  hideAll('.screen');
  // clear next-show feedback form
  const nf = $('next-feedback'), na = $('next-anything'), ns = $('next-fb-status');
  if (nf) nf.value = '';
  if (na) na.value = '';
  if (ns) ns.textContent = '';
  show('scr-voted');
}

async function submitNextShowFeedback() {
  const feedbackText = ($('next-feedback')?.value || '').trim();
  const anything = ($('next-anything')?.value || '').trim();
  const statusEl = $('next-fb-status');
  if (!feedbackText && !anything) {
    statusEl.textContent = 'Please write something before submitting.';
    statusEl.style.color = '#dc2626';
    return;
  }
  statusEl.textContent = '';
  const d = await api('/api/next-feedback', {
    method: 'POST',
    body: { deviceId, feedbackText, anything }
  });
  if (d.error) {
    statusEl.textContent = d.error;
    statusEl.style.color = '#dc2626';
    return;
  }
  statusEl.textContent = 'Thank you! Your feedback was recorded.';
  statusEl.style.color = '';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ─── Admin ──────────────────────────────────────────────
function handleAdminTrigger() {
  if (isAdmin) { show('admin-panel'); refreshAdminPanel(); }
  else show('admin-login-modal');
}

async function loginAdmin() {
  const pw = $('admin-pw-input').value;
  const d = await api('/api/admin/login', { method: 'POST', body: { password: pw, deviceId } });
  if (d.error) { $('admin-login-err').textContent = 'Wrong password'; return; }
  isAdminOwner = !!d.isOwner;
  $('admin-login-err').textContent = isAdminOwner ? '' : 'Another device is the active admin owner. You can only use Complete Reset.';
  isAdmin = true; adminPW = pw;
  localStorage.setItem('pcts_admin', '1');
  localStorage.setItem('pcts_admin_owner', isAdminOwner ? '1' : '0');
  localStorage.setItem('pcts_pw', pw);
  $('admin-trigger').classList.add('active');
  hide('admin-login-modal'); show('admin-panel');
  refreshAdminPanel();
}

function refreshAdminPanel() {
  if (!appState) return;
  const ownerOnlyIds = ['adm-sec-control', 'adm-sec-perf', 'adm-sec-upload', 'adm-sec-sups', 'adm-sec-results', 'adm-reset-basic'];
  ownerOnlyIds.forEach(id => { const el = $(id); if (el) el.style.display = isAdminOwner ? '' : 'none'; });
  const warn = $('adm-nonowner-warning');
  if (warn) warn.style.display = isAdminOwner ? 'none' : '';
  if (!isAdminOwner) return;
  const currentOrderPos = appState.currentPerformance ? getOrderedPosition(appState.currentPerformance.id) : appState.state.currentPerfIndex + 1;
  $('adm-perf-label').textContent = `${currentOrderPos || appState.state.currentPerfIndex + 1} / ${appState.totalPerformances}`;
  $('adm-media-perf').innerHTML = performances.map(p =>
    `<option value="${p.id}">${p.order}. ${esc(p.title)}</option>`).join('');
  $('adm-sup-list').innerHTML = superlatives.map(s =>
    `<span class="sup-chip">${esc(s.name)} <button onclick="admDelSup('${s.id}')">×</button></span>`).join('');
  
  // Performance list
  const sorted = getOrderedPerformances();
  $('adm-perf-list').innerHTML = sorted.map((p, idx) =>
    `<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem;background:var(--g100);border-radius:6px;margin-bottom:.4rem">
      <span style="font-weight:700;color:#01206A;min-width:24px">#${idx + 1}</span>
      <span style="flex:1;font-weight:600">${esc(p.title)}</span>
      <button class="btn btn-sm btn-secondary" onclick="admMovePerf(${p.id}, -1)">↑</button>
      <button class="btn btn-sm btn-secondary" onclick="admMovePerf(${p.id}, 1)">↓</button>
      <button class="btn btn-sm btn-secondary" onclick="admEditPerf(${p.id})">Edit</button>
      <button class="btn btn-sm btn-danger" onclick="admDeletePerf(${p.id})">Delete</button>
    </div>`
  ).join('');
  
  // Media list
  const allMedia = performances.flatMap(p => (p.media || []).map(m => ({ ...m, perfTitle: p.title })));
  $('adm-media-list').innerHTML = allMedia.length ? '<div style="margin-top:.8rem"><strong>Uploaded Media:</strong></div>' + allMedia.map(m =>
    `<div style="display:flex;align-items:center;gap:.5rem;padding:.4rem;background:var(--g100);border-radius:6px;margin-top:.4rem;font-size:.85rem">
      <span style="flex:1">${esc(m.perfTitle)} - ${esc(m.originalName || m.filename)}</span>
      <button class="btn btn-sm btn-danger" onclick="admDeleteMedia('${m.id}')">Delete</button>
    </div>`
  ).join('') : '';
}

let editingPerfId = null;
async function admAddPerf() {
  editingPerfId = null;
  $('adm-perf-title').value = '';
  $('adm-perf-performers').value = '';
  $('adm-perf-bio').value = '';
  $('adm-perf-desc').value = '';
  $('adm-perf-note').value = '';
  $('adm-perf-q').value = '';
  show('adm-perf-form');
}

async function admEditPerf(id) {
  const p = performances.find(x => x.id === id);
  if (!p) return;
  editingPerfId = id;
  $('adm-perf-title').value = p.title;
  $('adm-perf-performers').value = p.performers;
  $('adm-perf-bio').value = p.bio || '';
  $('adm-perf-desc').value = p.description || '';
  $('adm-perf-note').value = p.performerNote || '';
  $('adm-perf-q').value = p.customQuestion || '';
  show('adm-perf-form');
}

function admCancelPerf() {
  hide('adm-perf-form');
  editingPerfId = null;
}

async function admSavePerf() {
  const body = {
    title: $('adm-perf-title').value.trim(),
    performers: $('adm-perf-performers').value.trim(),
    bio: $('adm-perf-bio').value.trim(),
    description: $('adm-perf-desc').value.trim(),
    performerNote: $('adm-perf-note').value.trim(),
    customQuestion: $('adm-perf-q').value.trim()
  };
  if (!body.title) { alert('Title is required'); return; }
  
  if (editingPerfId) {
    await api(`/api/admin/performance/${editingPerfId}`, { method: 'PUT', body });
  } else {
    await api('/api/admin/performance', { method: 'POST', body });
  }
  await loadSync();
  render();
  refreshAdminPanel();
  hide('adm-perf-form');
  editingPerfId = null;
}

async function admMovePerf(id, delta) {
  const sorted = getOrderedPerformances();
  const index = sorted.findIndex(p => p.id === id);
  if (index < 0) return;
  const target = index + delta;
  if (target < 0 || target >= sorted.length) return;
  const swapped = [...sorted];
  [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
  const orderedIds = swapped.map(p => p.id);
  const d = await api('/api/admin/performance/reorder', { method: 'POST', body: { orderedIds } });
  if (d.error) return alert(d.error);
  await loadSync();
  render();
  refreshAdminPanel();
}

async function admDeletePerf(id) {
  if (!confirm(`Delete "${performances.find(p => p.id === id)?.title}"? This cannot be undone.`)) return;
  await api(`/api/admin/performance/${id}`, { method: 'DELETE' });
  await loadSync();
  render();
  refreshAdminPanel();
}

async function admDeleteMedia(id) {
  if (!confirm('Delete this media file?')) return;
  await api(`/api/admin/media/${id}`, { method: 'DELETE' });
  await loadSync();
  render();
  refreshAdminPanel();
}

// Helper to get media list for admin panel
let allMediaCache = [];
async function refreshMediaCache() {
  const perfs = await api('/api/performances');
  allMediaCache = perfs.flatMap(p => (p.media || []).map(m => ({ ...m, perfTitle: p.title })));
}

async function admSetPhase(phase) {
  const body = { phase };
  if (phase === 'performing') body.feedbackOpen = false;
  const d = await api('/api/admin/phase', { method: 'POST', body });
  if (d?.error) return alert(d.error);
  await loadSync(); render(); refreshAdminPanel();
}
async function admPrev() {
  const i = Math.max(0, appState.state.currentPerfIndex - 1);
  const d = await api('/api/admin/phase', { method: 'POST', body: { currentPerfIndex: i, phase: 'performing', feedbackOpen: false } });
  if (d?.error) return alert(d.error);
  await loadSync(); render(); refreshAdminPanel();
}
async function admNext() {
  const i = Math.min(appState.totalPerformances - 1, appState.state.currentPerfIndex + 1);
  const d = await api('/api/admin/phase', { method: 'POST', body: { currentPerfIndex: i, phase: 'performing', feedbackOpen: false } });
  if (d?.error) return alert(d.error);
  await loadSync(); render(); refreshAdminPanel();
}
async function admToggleFeedback() {
  await api('/api/admin/phase', { method: 'POST', body: { feedbackOpen: !appState.state.feedbackOpen } });
  await loadSync(); render(); refreshAdminPanel();
}
async function admOpenVoting() {
  if (!confirm('Open final voting? This ends the performance phase.')) return;
  const d = await api('/api/admin/phase', { method: 'POST', body: { phase: 'voting', votingOpen: true, feedbackOpen: false } });
  if (d?.error) return alert(d.error);
  await loadSync(); render(); refreshAdminPanel();
}
async function admUpload() {
  const file = $('adm-media-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('media', file);
  fd.append('performanceId', $('adm-media-perf').value);
  $('upload-status').textContent = 'Uploading…';
  const d = await api('/api/admin/upload', { method: 'POST', body: fd });
  $('upload-status').textContent = d.error || 'Uploaded ✓';
  $('adm-media-file').value = '';
  await loadSync();
  render();
  refreshAdminPanel();
}
async function admAddSup() {
  const name = $('adm-sup-name').value.trim();
  if (!name) return;
  await api('/api/admin/superlative', { method: 'POST', body: { name } });
  $('adm-sup-name').value = '';
  await loadSync(); refreshAdminPanel();
}
async function admDelSup(id) {
  await api(`/api/admin/superlative/${id}`, { method: 'DELETE' });
  await loadSync(); refreshAdminPanel();
}
async function admShowResults() {
  const d = await api('/api/admin/results');
  if (d.error) return;
  const voters = d.voters || [];
  let h = '<h5 style="margin:.2rem 0 .5rem;color:#01206A">Top 3</h5>';
  (d.ranked || []).slice(0, 3).forEach((p, i) => {
    const cls = i === 0 ? 'gold' : i === 1 ? 'silver' : 'bronze';
    h += `<div class="res-item"><span class="res-rank ${cls}">${i + 1}</span>
          <span class="res-name">${esc(p.title)}</span><span class="res-score">${p.score} pts</span></div>`;
  });
  if (!d.ranked || d.ranked.length === 0) h += '<p style="color:var(--g500);margin:.4rem 0">No rankings yet.</p>';
  h += `<h5 style="margin:.8rem 0 .4rem;color:#01206A">Voters (${voters.length})</h5>`;
  if (voters.length === 0) {
    h += '<p style="color:var(--g500);margin:.4rem 0">No voters yet.</p>';
  } else {
    h += '<div>';
    voters.forEach(v => {
      const name = `${esc(v.firstName || 'Unknown')} ${esc(v.lastName || '')}`.trim() || 'Unknown';
      h += `<details style="margin:.3rem 0;padding:.35rem .15rem;border-bottom:1px solid var(--g100)">
        <summary style="cursor:pointer;color:var(--g800);font-weight:600">${name}</summary>
        <div style="padding:.35rem 0 .35rem .2rem">
          <div style="font-size:.85rem;color:var(--g600);margin-bottom:.3rem"><strong>Performance Feedback</strong></div>
          ${((v.perfFeedback || []).map(f => `<div style="margin-bottom:.35rem">
            <div style="font-size:.82rem;color:var(--g600)">${esc(f.performanceTitle || '')}</div>
            ${f.customAnswer ? `<div style="font-size:.85rem;color:var(--g700)"><strong>Q:</strong> ${esc(f.customAnswer)}</div>` : ''}
            ${f.feedbackText ? `<div style="font-size:.88rem;color:var(--g800)">${esc(f.feedbackText)}</div>` : ''}
          </div>`).join('') || '<div style="font-size:.85rem;color:var(--g500)">No performance feedback submitted.</div>')}
          <div style="font-size:.85rem;color:var(--g600);margin:.3rem 0 .15rem"><strong>For Next Year</strong></div>
          <div style="font-size:.88rem;color:var(--g800)">${v.nextFeedback ? esc(v.nextFeedback) : '<span style="color:var(--g500)">No response.</span>'}</div>
          <div style="font-size:.85rem;color:var(--g600);margin:.3rem 0 .15rem"><strong>Anything</strong></div>
          <div style="font-size:.88rem;color:var(--g800)">${v.anything ? esc(v.anything) : '<span style="color:var(--g500)">No response.</span>'}</div>
        </div>
      </details>`;
    });
    h += '</div>';
  }
  $('adm-results').innerHTML = h;
}
async function admReset() {
  if (!confirm('Reset ALL data? This cannot be undone.')) return;
  const d = await api('/api/admin/reset', { method: 'POST' });
  if (d.error) return alert(d.error);
  localStorage.removeItem('pcts_voted');
  feedbackDone = {};
  await loadSync();
  render(); refreshAdminPanel();
}

async function admCompleteReset() {
  if (!confirm('COMPLETE RESET: clears all data and logs out every admin device. Continue?')) return;
  const d = await api('/api/admin/reset-complete', { method: 'POST' });
  if (d.error) return alert(d.error);
  forceLogoutToLogin();
  location.reload();
}

async function admShowFullRankingList() {
  const d = await api('/api/admin/results');
  if (d.error) return;
  const rows = d.ranked.map((p, i) =>
    `<div class="res-item"><span class="res-rank other">${i + 1}</span><span class="res-name">${esc(p.title)}</span><span class="res-score">${p.score} pts</span></div>`
  ).join('');
  $('adm-results').innerHTML = `<h5 style="margin:.2rem 0 .6rem;color:#01206A">Full Ranking List</h5>${rows || '<p>No rankings yet.</p>'}`;
}
