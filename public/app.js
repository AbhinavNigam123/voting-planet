/* ========================================================
   Panther Creek Talent Show — Client
   ======================================================== */

// ─── State ──────────────────────────────────────────────
let deviceId = null;      // fingerprint-based device ID
let isAdmin = false;
let adminPW = '';
let appState = null;
let performances = [];
let superlatives = [];
let feedbackDone = {};

// ─── Helpers ────────────────────────────────────────────
const $ = s => document.getElementById(s);
const hide = id => $(id).classList.add('hidden');
const show = id => $(id).classList.remove('hidden');
function hideAll(sel){ document.querySelectorAll(sel).forEach(e=>e.classList.add('hidden')); }

async function api(url, opts = {}) {
  if (adminPW && !opts.headers) opts.headers = {};
  if (adminPW && opts.headers) opts.headers['x-admin-password'] = adminPW;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
  return r.json();
}

// ─── Device Fingerprint ─────────────────────────────────
async function generateFingerprint() {
  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 50;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillStyle = '#002D62';
  ctx.fillText('PC Talent Show', 2, 2);
  ctx.fillStyle = 'rgba(91,164,207,0.7)';
  ctx.fillRect(50, 10, 80, 20);
  const canvasData = canvas.toDataURL();
  const raw = [
    canvasData,
    screen.width, screen.height, screen.colorDepth,
    navigator.language, navigator.platform,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 0,
    navigator.maxTouchPoints || 0
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ─── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  isAdmin = localStorage.getItem('pcts_admin') === '1';
  adminPW = localStorage.getItem('pcts_pw') || '';

  // Generate or reuse fingerprint
  deviceId = localStorage.getItem('pcts_did');
  if (!deviceId) {
    deviceId = await generateFingerprint();
    localStorage.setItem('pcts_did', deviceId);
  }

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
  const d = await api('/api/auth/join', { method: 'POST', body: { deviceId, firstName, lastName } });
  if (d.error) { $('auth-error').textContent = d.error; return; }
  localStorage.setItem('pcts_joined', '1');
  localStorage.setItem('pcts_firstName', firstName);
  localStorage.setItem('pcts_lastName', lastName);
  enterApp();
}

async function enterApp() {
  hide('auth-screen'); show('app');
  if (isAdmin) $('admin-trigger').classList.add('active');
  await Promise.all([loadState(), loadPerfs(), loadSups()]);
  connectSSE();
  render();
}

// ─── SSE ────────────────────────────────────────────────
let _es = null;
function connectSSE() {
  if (_es) { _es.close(); _es = null; }
  _es = new EventSource('/api/events');
  _es.addEventListener('stateUpdate', async e => {
    appState = JSON.parse(e.data);
    try { await Promise.all([loadPerfs(), loadSups()]); } catch(err) { console.warn('SSE resync failed', err); }
    render();
    if (isAdmin) refreshAdminPanel();
  });
  _es.addEventListener('mediaUpdate', async e => {
    const m = JSON.parse(e.data);
    if (!m.deleted) {
      const p = performances.find(x => x.id === m.performanceId);
      if (p) { p.media = p.media || []; p.media.push(m); }
    }
    try { await loadPerfs(); } catch(err) {}
    renderMedia();
    if (isAdmin) refreshAdminPanel();
  });
  _es.onerror = () => { _es.close(); _es = null; setTimeout(connectSSE, 2000); };
}

async function loadState() { appState = await api('/api/state'); }
async function loadPerfs() {
  performances = await api('/api/performances');
  if (appState && appState.state.phase === 'waiting') renderProgram();
}
async function loadSups()  { superlatives = await api('/api/superlatives'); }

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
  const chronoPos = getChronologicalPosition(p.id);
  $('perf-num').textContent = chronoPos || appState.state.currentPerfIndex + 1;
  $('perf-total').textContent = appState.totalPerformances;
  $('perf-title').textContent = p.title;
  $('perf-performers').textContent = p.performers;
  $('perf-bio').textContent = p.bio || '';
  $('perf-desc').textContent = p.description || '';
  $('perf-bio').style.display = p.bio ? '' : 'none';
  $('perf-desc').style.display = p.description ? '' : 'none';
  document.querySelector('.perf-desc-label').style.display = p.description ? '' : 'none';
  if (p.performerNote) {
    $('perf-note').textContent = p.performerNote;
    $('perf-note').style.display = '';
  } else {
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

function renderCurrentMedia() {
  const media = appState.currentMedia || [];
  $('perf-media').innerHTML = media.map(m =>
    m.type === 'video'
      ? `<video src="/uploads/${m.filename}" controls playsinline preload="metadata" style="max-width:100%"></video>`
      : `<img src="/uploads/${m.filename}" alt="clip" loading="lazy">`
  ).join('');
}

function renderMedia() {
  if (appState && appState.state.phase === 'performing') renderCurrentMedia();
}

function parseTime(timeStr) {
  if (!timeStr || timeStr === 'TBA') return Infinity;
  const cleaned = timeStr.replace(/PM|pm|AM|am/gi, '').trim();
  const match = cleaned.match(/(\d+):(\d+)/);
  if (!match) return Infinity;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function getChronologicallySorted() {
  return [...performances].sort((a, b) => {
    const timeA = parseTime(a.tentativeTime);
    const timeB = parseTime(b.tentativeTime);
    if (timeA === timeB) return a.order - b.order;
    return timeA - timeB;
  });
}

function getChronologicalPosition(perfId) {
  const sorted = getChronologicallySorted();
  const index = sorted.findIndex(p => p.id === perfId);
  return index >= 0 ? index + 1 : null;
}

function renderProgram() {
  const sorted = getChronologicallySorted();
  const html = sorted.map((p, idx) =>
    `<div class="prog-item">
      <div class="prog-num">${idx + 1}</div>
      <div class="prog-info">
        <div class="prog-title">${esc(p.title)}</div>
        <div class="prog-performers">${esc(p.performers)}</div>
      </div>
      <div class="prog-time">${esc(p.tentativeTime || 'TBA')}</div>
    </div>`
  ).join('');
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
  const sorted = getChronologicallySorted();
  const html = sorted.map((p, idx) => {
    const thumb = (p.media && p.media.length) ? mediaThumb(p.media[0]) : '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>';
    const opts = '<option value="">—</option>' + [1,2,3,4,5].map(n => `<option value="${n}">Rank ${n}</option>`).join('');
    return `<div class="vote-card" data-pid="${p.id}">
      <div class="vc-media">${thumb}</div>
      <div class="vc-info">
        <div class="vc-title">#${idx + 1} - ${esc(p.title)}</div>
        <div class="vc-name">${esc(p.performers)}</div>
        <select class="field rank-sel" data-pid="${p.id}" style="width:auto;margin-top:.4rem">${opts}</select>
      </div>
    </div>`;
  }).join('');
  $('vote-cards').innerHTML = html;
  
  // Add change listeners to update dropdowns dynamically
  document.querySelectorAll('.rank-sel').forEach(sel => {
    sel.addEventListener('change', updateVotingDropdowns);
  });

  const sortedForOpts = getChronologicallySorted();
  const perfOpts = '<option value="">— Select —</option>' +
    sortedForOpts.map((p, idx) => `<option value="${p.id}">#${idx + 1} - ${esc(p.title)}</option>`).join('');
  $('sup-votes').innerHTML = superlatives.map(s =>
    `<div class="sup-row"><span class="sup-name">${esc(s.name)}</span>
     <select class="field sup-sel" data-sid="${s.id}" style="width:auto">${perfOpts}</select></div>`
  ).join('');
  
  updateVotingProgress();
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
}

function updateVotingProgress() {
  const selected = Array.from(document.querySelectorAll('.rank-sel')).filter(s => s.value).length;
  const pct = (selected / 5) * 100;
  $('vote-progress-bar').style.width = pct + '%';
  $('vote-count').textContent = `${selected} of 5 performances ranked`;
}

function mediaThumb(m) {
  if (m.type === 'video') {
    return `<video src="/uploads/${m.filename}" controls playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>`;
  }
  return `<img src="/uploads/${m.filename}" alt="" style="width:100%;height:100%;object-fit:cover">`;
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

  const d = await api('/api/vote', { method: 'POST', body: { deviceId, rankings, superlativeVotes } });
  if (d.error) { $('vote-status').textContent = d.error; $('vote-status').style.color='#dc2626'; return; }
  localStorage.setItem('pcts_voted', '1');
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
  const d = await api('/api/admin/login', { method: 'POST', body: { password: pw } });
  if (d.error) { $('admin-login-err').textContent = 'Wrong password'; return; }
  isAdmin = true; adminPW = pw;
  localStorage.setItem('pcts_admin', '1');
  localStorage.setItem('pcts_pw', pw);
  $('admin-trigger').classList.add('active');
  hide('admin-login-modal'); show('admin-panel');
  refreshAdminPanel();
}

function refreshAdminPanel() {
  if (!appState) return;
  const currentChronoPos = appState.currentPerformance ? getChronologicalPosition(appState.currentPerformance.id) : appState.state.currentPerfIndex + 1;
  $('adm-perf-label').textContent = `${currentChronoPos || appState.state.currentPerfIndex + 1} / ${appState.totalPerformances}`;
  $('adm-media-perf').innerHTML = performances.map(p =>
    `<option value="${p.id}">${p.order}. ${esc(p.title)}</option>`).join('');
  $('adm-sup-list').innerHTML = superlatives.map(s =>
    `<span class="sup-chip">${esc(s.name)} <button onclick="admDelSup('${s.id}')">×</button></span>`).join('');
  
  // Performance list
  const sorted = getChronologicallySorted();
  $('adm-perf-list').innerHTML = sorted.map((p, idx) =>
    `<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem;background:var(--g100);border-radius:6px;margin-bottom:.4rem">
      <span style="font-weight:700;color:#01206A;min-width:24px">#${idx + 1}</span>
      <span style="flex:1;font-weight:600">${esc(p.title)}</span>
      <span style="font-size:.85rem;color:var(--g500)">${esc(p.tentativeTime || '')}</span>
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
  $('adm-perf-time').value = '';
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
  $('adm-perf-time').value = p.tentativeTime || '';
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
    tentativeTime: $('adm-perf-time').value.trim(),
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
  await loadPerfs();
  await loadState();
  render();
  refreshAdminPanel();
  hide('adm-perf-form');
  editingPerfId = null;
}

async function admDeletePerf(id) {
  if (!confirm(`Delete "${performances.find(p => p.id === id)?.title}"? This cannot be undone.`)) return;
  await api(`/api/admin/performance/${id}`, { method: 'DELETE' });
  await loadPerfs();
  await loadState();
  render();
  refreshAdminPanel();
}

async function admDeleteMedia(id) {
  if (!confirm('Delete this media file?')) return;
  await api(`/api/admin/media/${id}`, { method: 'DELETE' });
  await loadPerfs();
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
  await api('/api/admin/phase', { method: 'POST', body });
  await loadState(); render(); refreshAdminPanel();
}
async function admPrev() {
  const i = Math.max(0, appState.state.currentPerfIndex - 1);
  await api('/api/admin/phase', { method: 'POST', body: { currentPerfIndex: i, phase: 'performing', feedbackOpen: false } });
  await loadState(); render(); refreshAdminPanel();
}
async function admNext() {
  const i = Math.min(appState.totalPerformances - 1, appState.state.currentPerfIndex + 1);
  await api('/api/admin/phase', { method: 'POST', body: { currentPerfIndex: i, phase: 'performing', feedbackOpen: false } });
  await loadState(); render(); refreshAdminPanel();
}
async function admToggleFeedback() {
  await api('/api/admin/phase', { method: 'POST', body: { feedbackOpen: !appState.state.feedbackOpen } });
  await loadState(); render();
}
async function admOpenVoting() {
  if (!confirm('Open final voting? This ends the performance phase.')) return;
  await api('/api/admin/phase', { method: 'POST', body: { phase: 'voting', votingOpen: true, feedbackOpen: false } });
  await loadState(); await loadPerfs(); render(); refreshAdminPanel();
}
async function admUpload() {
  const file = $('adm-media-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('media', file);
  fd.append('performanceId', $('adm-media-perf').value);
  $('upload-status').textContent = 'Uploading…';
  const d = await fetch('/api/admin/upload', { method: 'POST', headers: { 'x-admin-password': adminPW }, body: fd }).then(r => r.json());
  $('upload-status').textContent = d.error || 'Uploaded ✓';
  $('adm-media-file').value = '';
  await loadPerfs();
  refreshAdminPanel();
}
async function admAddSup() {
  const name = $('adm-sup-name').value.trim();
  if (!name) return;
  await api('/api/admin/superlative', { method: 'POST', body: { name } });
  $('adm-sup-name').value = '';
  await loadSups(); refreshAdminPanel();
}
async function admDelSup(id) {
  await api(`/api/admin/superlative/${id}`, { method: 'DELETE' });
  await loadSups(); refreshAdminPanel();
}
async function admShowResults() {
  const d = await api('/api/admin/results');
  let h = `<p style="margin-bottom:.6rem"><b>${d.totalVoters}</b> voters · <b>${d.totalFeedback}</b> feedback entries</p>`;
  h += '<h5 style="margin:.6rem 0 .3rem;color:#01206A">Rankings</h5>';
  d.ranked.forEach((p, i) => {
    const cls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'other';
    h += `<div class="res-item"><span class="res-rank ${cls}">${i+1}</span>
          <span class="res-name">${esc(p.title)}</span><span class="res-score">${p.score} pts</span></div>`;
  });
  h += '<h5 style="margin:.8rem 0 .3rem;color:#01206A">Superlatives</h5>';
  d.superlatives.forEach(s => {
    h += `<div class="res-sup"><b>${esc(s.name)}:</b> ${s.winner ? esc(s.winner.title) : '—'} (${s.winnerVotes} votes)</div>`;
  });
  h += '<h5 style="margin:.8rem 0 .3rem;color:#01206A">Performance Feedback</h5>';
  Object.entries(d.feedback).forEach(([pid, entries]) => {
    const perf = performances.find(p => p.id === Number(pid));
    h += `<details style="margin-bottom:.4rem"><summary style="cursor:pointer;font-weight:600;padding:.4rem;background:var(--g100);border-radius:6px">${perf ? esc(perf.title) : pid} (${entries.length})</summary>`;
    entries.forEach(f => {
      const name = `${esc(f.firstName || 'Unknown')} ${esc(f.lastName || '')}`.trim();
      h += `<details style="margin:.3rem 0;padding:.4rem;background:var(--white);border-radius:6px;border-left:3px solid var(--columbia)">
        <summary style="cursor:pointer;font-weight:600;color:#01206A">${name}</summary>
        <div style="padding:.4rem 0;margin-top:.4rem">`;
      if (f.customAnswer) h += `<div style="font-size:.85rem;color:var(--g600);margin-bottom:.3rem"><strong>Q:</strong> <i>${esc(f.customAnswer)}</i></div>`;
      if (f.feedbackText) h += `<div style="font-size:.9rem;color:var(--g800);line-height:1.5">${esc(f.feedbackText)}</div>`;
      h += `</div></details>`;
    });
    h += '</details>';
  });
  if (d.nextShowFeedback && d.nextShowFeedback.length > 0) {
    h += '<h5 style="margin:.8rem 0 .3rem;color:#01206A">Next Year Feedback</h5>';
    d.nextShowFeedback.forEach(f => {
      const name = `${esc(f.firstName || 'Unknown')} ${esc(f.lastName || '')}`.trim();
      h += `<details style="margin:.3rem 0;padding:.4rem;background:var(--white);border-radius:6px;border-left:3px solid var(--columbia)">
        <summary style="cursor:pointer;font-weight:600;color:#01206A">${name}</summary>
        <div style="padding:.4rem 0;margin-top:.4rem">`;
      if (f.feedbackText) h += `<div style="font-size:.9rem;color:var(--g800);margin-bottom:.4rem"><strong>For Next Year:</strong><br>${esc(f.feedbackText)}</div>`;
      if (f.anything) h += `<div style="font-size:.9rem;color:var(--g800);line-height:1.5"><strong>Anything:</strong><br>${esc(f.anything)}</div>`;
      h += `</div></details>`;
    });
  }
  $('adm-results').innerHTML = h;
}
async function admReset() {
  if (!confirm('Reset ALL data? This cannot be undone.')) return;
  await api('/api/admin/reset', { method: 'POST' });
  localStorage.removeItem('pcts_voted');
  feedbackDone = {};
  await Promise.all([loadState(), loadPerfs(), loadSups()]);
  render(); refreshAdminPanel();
}
