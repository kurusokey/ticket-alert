// ══════════════════════════════════════
// THEME
// ══════════════════════════════════════

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === 'light' ? '#f5f5f7' : '#0a0a0f';
    localStorage.setItem('gfmt_theme', theme);
}

function toggleThemeSwitch() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

function initTheme() {
    const saved = localStorage.getItem('gfmt_theme');
    const themeToggle = document.getElementById('settingsTheme');
    if (themeToggle) themeToggle.checked = (saved === 'light') || (!saved && window.matchMedia('(prefers-color-scheme: light)').matches);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (!localStorage.getItem('gfmt_theme')) {
            applyTheme(e.matches ? 'dark' : 'light');
        }
    });
}

// ══════════════════════════════════════
// GLOBALS
// ══════════════════════════════════════

const API = '';
const AUTH_KEY = 'gfmt_auth';
let events = [];
let editingId = null;
let pollInterval = null;

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════

function getAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; }
    catch { return null; }
}

function setAuth(data) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(data));
}

function authHeaders() {
    const auth = getAuth();
    return auth?.pin ? { 'Authorization': `Bearer ${auth.pin}` } : {};
}

async function doAuth() {
    const name = document.getElementById('authName').value.trim();
    const pin = document.getElementById('authPin').value.trim();
    if (!name) { showToast('Entre ton prenom', true); return; }
    if (!/^\d{6}$/.test(pin)) { showToast('Le code PIN doit faire 6 chiffres', true); return; }
    try {
        const res = await fetch(`${API}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, pin }),
        });
        const data = await res.json();
        if (data.ok) {
            setAuth({ pin: data.pin, name: data.name });
            if (data.isNew) showToast('Compte cree');
            finishAuth();
            if (data.isNew) showOnboarding();
        } else {
            showToast(data.error || 'Erreur', true);
        }
    } catch (e) {
        if (e.name === 'TypeError') {
            showToast('Pas de connexion internet', true);
        } else {
            showToast('Erreur de connexion', true);
        }
    }
}

function finishAuth() {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('mainApp').style.display = '';
    const auth = getAuth();
    if (auth) {
        document.getElementById('userInfo').innerHTML =
            `${esc(auth.name || '')} &mdash; <a class="settings-link" onclick="openSettings()">Parametres</a> &mdash; <a onclick="logout()">Deconnexion</a>`;
    }
    // Nettoyer et dedupliquer le state monitor local
    const mon = getMonState();
    if (mon.alerts?.length) {
        const seen = new Set();
        mon.alerts = mon.alerts.filter(a => {
            const key = (a.event || '') + '|' + (a.url || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    if (mon.logs?.length) {
        mon.logs = mon.logs.slice(-20); // garder que les 20 derniers logs
    }
    setMonState(mon);
    initApp();
}

function logout() {
    localStorage.removeItem(AUTH_KEY);
    location.reload();
}

function checkAuth() {
    const auth = getAuth();
    if (auth?.pin) {
        finishAuth();
    } else {
        document.getElementById('authScreen').classList.remove('hidden');
        document.getElementById('mainApp').style.display = 'none';
    }
}
let statusInterval = null;

const MON_KEY = 'gfmt_monitor';

// ══════════════════════════════════════
// SERVICE WORKER + PUSH
// ══════════════════════════════════════

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
        // Force check for updates every time the page loads
        reg.update();
        // Auto-reload when new SW takes over
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) { refreshing = true; location.reload(); }
        });
    });
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function isIOSSafari() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
}

async function togglePush() {
    if (!('PushManager' in window)) {
        if (isIOSSafari() && !isStandalone()) {
            showToast('Sur iPhone, installe l\'app d\'abord : Partager → Sur l\'ecran d\'accueil', true);
        } else if (isIOSSafari()) {
            showToast('Push non disponible sur cette version d\'iOS', true);
        } else {
            showToast('Push non supporte par ce navigateur', true);
        }
        return;
    }
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
        await existing.unsubscribe();
        await fetch('/api/push/unsubscribe', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }) }).catch(() => {});
        document.getElementById('pushBadge').textContent = 'Push off';
        document.getElementById('pushBadge').classList.remove('on');
        showToast('Push desactive');
    } else {
        try {
            const vapidRes = await fetch('/api/push/vapid', { headers: authHeaders() });
            const { publicKey } = await vapidRes.json();
            const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
            await fetch('/api/push/subscribe', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
            document.getElementById('pushBadge').textContent = 'Push on';
            document.getElementById('pushBadge').classList.add('on');
            showToast('Push active');
        } catch (e) {
            showToast('Erreur push: ' + e.message, true);
        }
    }
}

// Restore push badge state on load
async function restorePushState() {
    try {
        if (!('PushManager' in window) || !('serviceWorker' in navigator)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            document.getElementById('pushBadge').textContent = 'Push on';
            document.getElementById('pushBadge').classList.add('on');
        }
    } catch {}
}

// ══════════════════════════════════════
// ALERT SOUND (AudioContext)
// ══════════════════════════════════════

let alertSoundPlayed = {};

function playAlertSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [523, 659, 784, 1047].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'square';
            osc.frequency.value = freq;
            gain.gain.value = 0.15;
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.1);
        });
    } catch {}
}

// ══════════════════════════════════════
// MONITOR (100% client-side state)
// ══════════════════════════════════════

function getMonState() {
    try { return JSON.parse(localStorage.getItem(MON_KEY)) || {}; }
    catch { return {}; }
}

function setMonState(s) {
    localStorage.setItem(MON_KEY, JSON.stringify(s));
}

function startMonitor() {
    const state = { running: true, check_count: 0, started_at: new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), logs: [], alerts: [] };
    setMonState(state);
    showToast('Surveillance lancee');
    renderMonitorUI();
    startPolling();
    startStatusPolling();
    // Also try server-side start (best effort)
    fetch(`${API}/api/monitor/start`, { method: 'POST', headers: authHeaders() }).catch(() => {});
}

function stopMonitor() {
    const state = getMonState();
    state.running = false;
    setMonState(state);
    stopPolling();
    stopStatusPolling();
    showToast('Surveillance arretee');
    renderMonitorUI();
    fetch(`${API}/api/monitor/stop`, { method: 'POST', headers: authHeaders() }).catch(() => {});
}

async function doCheck() {
    const state = getMonState();
    if (!state.running) return;

    const now = new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

    try {
        const res = await fetch(`${API}/api/monitor/scan`, { headers: authHeaders() });
        const data = await res.json();

        state.check_count = (state.check_count || 0) + 1;

        if (data.results) {
            for (const r of data.results) {
                if (r.status === 'OPEN' || r.status === 'CHANGED') {
                    const alertKey = r.event + '-' + (r.url || '') + '-' + r.status;
                    state.alerts.push({ time: now, event: r.event, url: r.url, detail: r.detail, md5: r.md5, newLinks: r.newLinks, contentChanged: r.contentChanged });
                    state.logs.push({ time: now, message: `🚨 ${r.event} — ${r.detail}`, level: 'alert', ticketUrl: r.ticketUrl || r.url });
                    // Vibrate phone
                    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
                    // Play sound for new alerts
                    if (!alertSoundPlayed[alertKey]) {
                        alertSoundPlayed[alertKey] = true;
                        playAlertSound();
                    }
                } else if (r.status === 'ERROR') {
                    state.logs.push({ time: now, message: `[${r.event}] ERREUR: ${r.detail}`, level: 'error' });
                } else {
                    state.logs.push({ time: now, message: `[${r.event}] ${r.detail}`, level: 'info' });
                }
            }
        }

        // Keep last 50 logs
        if (state.logs.length > 50) state.logs = state.logs.slice(-50);

    } catch (e) {
        const errMsg = e.name === 'TypeError' ? 'Pas de connexion' : (e.message || 'Erreur inconnue');
        state.logs.push({ time: now, message: `Erreur: ${errMsg}`, level: 'error' });
    }

    // Go to last page to show newest logs
    const LOGS_PER_PAGE = 3;
    currentLogPage = Math.max(0, Math.ceil(state.logs.length / LOGS_PER_PAGE) - 1);

    setMonState(state);
    renderMonitorUI();
}

// Lightweight status polling (reads server KV, no scan)
async function pollStatus() {
    try {
        const res = await fetch(`${API}/api/monitor/status`, { headers: authHeaders() });
        const data = await res.json();
        if (data && data.check_count !== undefined) {
            const state = getMonState();
            // Merge server-side stats if available
            if (data.check_count > (state.check_count || 0)) {
                state.check_count = data.check_count;
            }
            if (data.alerts && data.alerts.length) {
                for (const a of data.alerts) {
                    const exists = state.alerts.some(sa => sa.event === a.event && sa.time === a.time);
                    if (!exists) {
                        state.alerts.push(a);
                        const alertKey = a.event + '-' + (a.url || '') + '-server';
                        if (!alertSoundPlayed[alertKey]) {
                            alertSoundPlayed[alertKey] = true;
                            playAlertSound();
                        }
                    }
                }
            }
            setMonState(state);
            renderMonitorUI();
        }
    } catch {}
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(doCheck, 10000);
    doCheck();
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(pollStatus, 15000);
}

function stopStatusPolling() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

// Keep page alive on mobile — prevents browser from suspending the tab
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch {}
}

// Re-acquire wake lock + resume polling when page becomes visible again
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        const state = getMonState();
        if (state.running) {
            requestWakeLock();
            if (!pollInterval) startPolling();
            if (!statusInterval) startStatusPolling();
        }
    }
});

function renderMonitorUI() {
    const data = getMonState();
    const panel = document.getElementById('monitorPanel');
    const dot = document.getElementById('monitorDot');
    const title = document.getElementById('monitorTitle');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const stats = document.getElementById('monitorStats');

    if (data.running) {
        const hasAlert = data.alerts?.length > 0;
        panel.className = 'monitor-panel' + (hasAlert ? ' has-alert' : ' active');
        dot.className = 'status-dot' + (hasAlert ? ' alert' : ' running');
        title.innerHTML = hasAlert
            ? '<strong style="color:#f97316">BILLETTERIE OUVERTE !</strong>'
            : '<strong>Surveillance active</strong> &mdash; check toutes les 10s';
        btnStart.style.display = 'none';
        btnStop.style.display = '';
        stats.style.display = '';
        document.getElementById('scheduler').style.display = 'none';
        document.getElementById('statChecks').textContent = data.check_count || 0;
        document.getElementById('statStarted').textContent = data.started_at || '--:--';
        requestWakeLock();
    } else {
        panel.className = 'monitor-panel';
        dot.className = 'status-dot';
        title.innerHTML = '<strong>Surveillance inactive</strong>';
        btnStart.style.display = '';
        btnStop.style.display = 'none';
        stats.style.display = 'none';
        document.getElementById('scheduler').style.display = '';
        if (wakeLock) { wakeLock.release(); wakeLock = null; }
    }

    // Ticket results: deduplicate by event+url, show only unique purchase links
    const tr = document.getElementById('ticketResults');
    const seen = new Set();
    const uniqueTickets = [];
    // Alerts first (have event + url)
    for (const a of (data.alerts || [])) {
        const key = (a.event || '') + '|' + (a.url || '');
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueTickets.push({ event: a.event, url: a.url, detail: a.detail, time: a.time });
    }
    // Logs with ticketUrl (backup)
    for (const l of (data.logs || [])) {
        if (!l.ticketUrl) continue;
        const key = '|' + l.ticketUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueTickets.push({ event: '', url: l.ticketUrl, detail: l.message, time: l.time });
    }

    if (uniqueTickets.length > 0) {
        const TICKETS_PER_PAGE = 3;
        const totalTicketPages = Math.ceil(uniqueTickets.length / TICKETS_PER_PAGE);
        if (currentTicketPage >= totalTicketPages) currentTicketPage = totalTicketPages - 1;
        if (currentTicketPage < 0) currentTicketPage = 0;
        const tStart = currentTicketPage * TICKETS_PER_PAGE;
        const pageTickets = uniqueTickets.slice(tStart, tStart + TICKETS_PER_PAGE);

        let html = pageTickets.map(t => `
            <div class="ticket-result">
                <div class="ticket-name">🎫 ${esc(t.event || 'Billetterie detectee')}</div>
                <div class="ticket-detail">${esc(t.detail || '')}</div>
                ${t.url ? `<a href="${esc(t.url)}" target="_blank">Acheter</a>` : ''}
            </div>
        `).join('');

        if (totalTicketPages > 1) {
            html += `<div class="pagination pagination-sm">
                <button class="page-btn page-btn-sm" onclick="goTicketPage(${currentTicketPage - 1})" ${currentTicketPage === 0 ? 'disabled' : ''}>←</button>
                <span class="page-info">${currentTicketPage + 1} / ${totalTicketPages}</span>
                <button class="page-btn page-btn-sm" onclick="goTicketPage(${currentTicketPage + 1})" ${currentTicketPage >= totalTicketPages - 1 ? 'disabled' : ''}>→</button>
            </div>`;
        }
        tr.innerHTML = html;
    } else if (data.running) {
        tr.innerHTML = '<div class="ticket-results-empty">Aucun billet detecte pour l\'instant...</div>';
    } else {
        tr.innerHTML = '';
    }

    // Logs techniques (hidden by default)
    const lc = document.getElementById('logContainer');
    const logToggle = document.getElementById('logToggle');
    const techLogs = (data.logs || []).filter(l => l.level !== 'alert');
    if (techLogs.length > 0) {
        logToggle.style.display = '';
        lc.innerHTML = techLogs.map(l => `
            <div class="log-line ${l.level || ''}">
                <span class="log-time">${l.time}</span>
                <span class="log-msg"> ${esc(l.message)}</span>
            </div>
        `).join('');
    } else {
        logToggle.style.display = 'none';
        lc.innerHTML = '';
    }
}

let currentTicketPage = 0;

function goTicketPage(page) {
    currentTicketPage = page;
    renderMonitorUI();
}

function toggleLogs() {
    const lc = document.getElementById('logContainer');
    const toggle = document.getElementById('logToggle');
    if (lc.style.display === 'none') {
        lc.style.display = '';
        toggle.textContent = 'Logs techniques ▲';
    } else {
        lc.style.display = 'none';
        toggle.textContent = 'Logs techniques ▼';
    }
}

// ══════════════════════════════════════
// STORAGE
// ══════════════════════════════════════

const LS_KEY = 'ticket_alert_events';

function lsGetEvents() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch { return []; }
}

function lsSaveEvents(data) {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
}

async function apiCall(path, opts = {}) {
    // If offline and it's a write operation, queue it
    if (!navigator.onLine && opts.method && opts.method !== 'GET') {
        enqueueAction({ type: opts.method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
        showToast('Action enregistree (hors-ligne)');
        return null;
    }
    try {
        opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
        const res = await fetch(`${API}${path}`, opts);
        if (res.ok) return await res.json();
        try {
            const err = await res.json();
            if (err.error) showToast(err.error, true);
        } catch {}
    } catch (e) {
        if (e.name === 'TypeError' && opts.method && opts.method !== 'GET') {
            enqueueAction({ type: opts.method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
            showToast('Action enregistree (hors-ligne)');
        } else if (e.name === 'TypeError') {
            // GET request failed offline — silently fail, use localStorage
        }
    }
    return null;
}

// ══════════════════════════════════════
// EVENTS
// ══════════════════════════════════════

async function loadEvents() {
    // Show skeleton loading
    const list = document.getElementById('eventsList');
    if (list && events.length === 0) {
        list.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
    }

    // If offline, use localStorage only
    if (!navigator.onLine) {
        events = lsGetEvents();
        renderEvents();
        return;
    }

    const data = await apiCall('/api/events');
    if (data && Array.isArray(data)) {
        events = data;
        const localEvents = lsGetEvents();
        const apiIds = new Set(events.map(e => e.id));
        for (const le of localEvents) {
            if (!apiIds.has(le.id)) events.push(le);
        }
    } else {
        events = lsGetEvents();
    }
    lsSaveEvents(events);
    renderEvents();
}

function getEventDates(ev) {
    // Support: dates[] of objects (v2), dates[] of strings (v1), date_start/date_end, date (legacy)
    if (ev.dates && Array.isArray(ev.dates) && ev.dates.length > 0) {
        return ev.dates.map(d => typeof d === 'string' ? { date: d, tickets: null } : d);
    }
    if (ev.date_start) {
        const arr = [{ date: ev.date_start, tickets: null }];
        if (ev.date_end) arr.push({ date: ev.date_end, tickets: null });
        return arr;
    }
    if (ev.date) return [{ date: ev.date, tickets: null }];
    return [];
}

function fmtDates(ev) {
    const dates = getEventDates(ev);
    if (dates.length === 0) return '';
    return dates.map(d => {
        let s = fmtDate(d.date);
        if (d.tickets) s += ` (${d.tickets} place${d.tickets > 1 ? 's' : ''})`;
        return s;
    }).join(' · ');
}

function getEventUrls(ev) {
    // Backward compat: if event has `url` (string), wrap as single entry
    if (ev.urls && Array.isArray(ev.urls) && ev.urls.length > 0) return ev.urls;
    if (ev.url) return [{ url: ev.url, label: '' }];
    return [];
}

const EVENTS_PER_PAGE = 3;
let currentPage = 0;

function getFilteredEvents() {
    let filtered = [...events];

    // Filter by type
    const filterType = document.getElementById('filterType')?.value || 'all';
    if (filterType !== 'all') {
        filtered = filtered.filter(ev => (ev.type || 'concert') === filterType);
    }

    // Filter by status
    const filterStatus = document.getElementById('filterStatus')?.value || 'all';
    if (filterStatus === 'active') {
        filtered = filtered.filter(ev => ev.active);
    } else if (filterStatus === 'paused') {
        filtered = filtered.filter(ev => !ev.active);
    }

    // Sort
    const sortBy = document.getElementById('filterSort')?.value || 'date';
    if (sortBy === 'date') {
        filtered.sort((a, b) => {
            const da = getEventDates(a)[0]?.date || '9999';
            const db = getEventDates(b)[0]?.date || '9999';
            return da.localeCompare(db);
        });
    } else if (sortBy === 'name') {
        filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'newest') {
        filtered.reverse();
    }

    return filtered;
}

function renderEvents() {
    const list = document.getElementById('eventsList');
    // Update counter in tab
    const counter = document.getElementById('eventsCount');
    if (counter) counter.textContent = events.length;
    // Update tab badge
    const tabBtn = document.getElementById('tabEvents');
    if (tabBtn) tabBtn.textContent = `Mes evenements (${events.length})`;

    const filtered = getFilteredEvents();

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">Aucun evenement surveille<br><br>Utilise l\'onglet "Rechercher" pour trouver des concerts</div>';
        return;
    }

    const totalPages = Math.ceil(filtered.length / EVENTS_PER_PAGE);
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;
    const start = currentPage * EVENTS_PER_PAGE;
    const pageEvents = filtered.slice(start, start + EVENTS_PER_PAGE);

    let html = pageEvents.map(ev => {
        const bc = ev.active ? 'badge-active' : 'badge-paused';
        const bt = ev.active ? 'Actif' : 'Pause';
        const daysUntil = getDaysUntil(ev);
        const isPast = daysUntil === null;
        let cc = ev.active ? '' : 'inactive';
        if (isPast) cc += ' past';
        const sd = ev.sale_date ? fmtDate(ev.sale_date) : '';
        const ed = fmtDates(ev);
        const urls = getEventUrls(ev);
        let urlsHtml = '';
        for (const u of urls) {
            let host = '';
            try { host = new URL(u.url).hostname.replace('www.',''); } catch {}
            if (host) {
                const lbl = u.label ? esc(u.label) : esc(host);
                const healthDot = urlHealthCache?.[ev.id]?.[u.url] !== undefined
                    ? `<span class="health-dot ${urlHealthCache[ev.id][u.url] ? 'ok' : 'err'}"></span>`
                    : '';
                urlsHtml += `<span>${healthDot}<a href="${esc(u.url)}" target="_blank">${lbl}</a></span>`;
            }
        }

        return `
            <div class="event-card ${cc}" data-event-id="${esc(ev.id)}">
                <div class="event-top">
                    <span class="event-name">${esc(ev.name)}</span>
                    <span class="badge ${bc}">${bt}</span>
                    ${fmtDaysUntil(daysUntil)}
                </div>
                <div class="event-info">
                    ${ev.venue ? `<span>${esc(ev.venue)}</span>` : ''}
                    ${ed ? `<span>${ed}</span>` : ''}
                    ${sd ? `<span>Vente: ${sd}</span>` : ''}
                    ${urlsHtml}
                </div>
                <div class="event-actions-row">
                    <button onclick="toggleEvent('${esc(ev.id)}')">${ev.active ? 'Pause' : 'Activer'}</button>
                    <button onclick="editEvent('${esc(ev.id)}')">Modifier</button>
                    <button class="btn-share" onclick="shareEvent('${esc(ev.id)}')">Partager</button>
                    <button class="btn-cal" onclick="exportCalendar('${esc(ev.id)}')">Calendrier</button>
                    <button class="btn-del" onclick="deleteEvent('${esc(ev.id)}')">Supprimer</button>
                </div>
            </div>`;
    }).join('');

    // Pagination
    if (totalPages > 1) {
        html += `<div class="pagination">
            <button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>←</button>
            <span class="page-info">${currentPage + 1} / ${totalPages}</span>
            <button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>→</button>
        </div>`;
    }

    list.innerHTML = html;

    // Attach swipe handlers on mobile
    if ('ontouchstart' in window) {
        initSwipeToDelete();
    }
}

function goPage(page) {
    currentPage = page;
    renderEvents();
    document.getElementById('eventsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ══════════════════════════════════════
// FORM (multi-URL support)
// ══════════════════════════════════════

let urlFieldCount = 0;

function addUrlField(urlVal, labelVal) {
    urlFieldCount++;
    const id = 'urlEntry_' + urlFieldCount;
    const container = document.getElementById('urlsList');
    const div = document.createElement('div');
    div.className = 'url-entry';
    div.id = id;
    div.innerHTML = `
        <div class="url-fields">
            <input type="url" class="url-input" placeholder="https://..." value="${esc(urlVal || '')}">
            <input type="text" class="label-input" placeholder="Label (optionnel)" value="${esc(labelVal || '')}">
        </div>
        <button type="button" class="btn-remove-url" onclick="removeUrlField('${id}')">&times;</button>
    `;
    container.appendChild(div);
}

function removeUrlField(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
    // Ensure at least one URL field
    if (document.getElementById('urlsList').children.length === 0) {
        addUrlField();
    }
}

function getFormUrls() {
    const entries = document.querySelectorAll('#urlsList .url-entry');
    const urls = [];
    entries.forEach(entry => {
        const urlInput = entry.querySelector('.url-input');
        const labelInput = entry.querySelector('.label-input');
        const url = urlInput ? urlInput.value.trim() : '';
        const label = labelInput ? labelInput.value.trim() : '';
        if (url) urls.push({ url, label });
    });
    return urls;
}

// ── Multi-date support ──

let dateFieldCount = 0;

function addDateField(val, tickets) {
    dateFieldCount++;
    const id = 'dateEntry_' + dateFieldCount;
    const container = document.getElementById('datesList');
    const div = document.createElement('div');
    div.className = 'date-entry';
    div.id = id;
    div.innerHTML = `
        <input type="date" class="date-input" value="${val || ''}">
        <input type="number" class="tickets-input" min="1" max="99" placeholder="Nb" value="${tickets || ''}" title="Nombre de places">
        <button type="button" class="btn-remove-url" onclick="removeDateField('${id}')">&times;</button>
    `;
    container.appendChild(div);
}

function removeDateField(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
    if (document.getElementById('datesList').children.length === 0) addDateField();
}

function getFormDates() {
    const entries = document.querySelectorAll('#datesList .date-entry');
    const dates = [];
    entries.forEach(entry => {
        const d = entry.querySelector('.date-input')?.value;
        const t = parseInt(entry.querySelector('.tickets-input')?.value) || null;
        if (d) dates.push({ date: d, tickets: t });
    });
    dates.sort((a, b) => a.date.localeCompare(b.date));
    return dates;
}

function openForm() {
    editingId = null;
    clearFormFields();
    document.getElementById('formTitle').textContent = 'Ajouter un evenement';
    document.getElementById('btnSave').textContent = 'Ajouter';
    document.getElementById('formOverlay').classList.add('open');
}

function closeForm() {
    document.getElementById('formOverlay').classList.remove('open');
    editingId = null;
}

function editEvent(id) {
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    editingId = id;
    document.getElementById('eventName').value = ev.name || '';
    document.getElementById('eventVenue').value = ev.venue || '';
    // Populate date fields
    document.getElementById('datesList').innerHTML = '';
    dateFieldCount = 0;
    const dates = getEventDates(ev);
    if (dates.length === 0) { addDateField(); } else { for (const d of dates) addDateField(d.date, d.tickets); }
    document.getElementById('eventSaleDate').value = (ev.sale_date || '').replace(' ', 'T');
    document.getElementById('eventMarker').value = ev.closed_marker || '';
    // Populate URL fields
    document.getElementById('urlsList').innerHTML = '';
    urlFieldCount = 0;
    const urls = getEventUrls(ev);
    if (urls.length === 0) {
        addUrlField();
    } else {
        for (const u of urls) addUrlField(u.url, u.label);
    }
    document.getElementById('formTitle').textContent = 'Modifier';
    document.getElementById('btnSave').textContent = 'Enregistrer';
    document.getElementById('formOverlay').classList.add('open');
}

async function saveEvent() {
    const name = document.getElementById('eventName').value.trim();
    const urls = getFormUrls();
    if (!name || urls.length === 0) { showToast('Nom et au moins une URL requis', true); return; }

    const ev = {
        id: editingId || slugify(name) + '-' + Date.now().toString(36),
        name,
        venue: document.getElementById('eventVenue').value.trim(),
        dates: getFormDates(),
        sale_date: document.getElementById('eventSaleDate').value ? document.getElementById('eventSaleDate').value.replace('T', ' ') : null,
        urls,
        url: urls[0].url, // backward compat: keep first URL as `url`
        closed_marker: document.getElementById('eventMarker').value.trim() || null,
        active: true,
    };

    const stored = lsGetEvents();
    if (editingId) {
        const idx = stored.findIndex(e => e.id === editingId);
        if (idx >= 0) stored[idx] = ev; else stored.push(ev);
    } else {
        stored.push(ev);
    }
    lsSaveEvents(stored);

    apiCall('/api/events', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
    });

    showToast(editingId ? 'Modifie' : 'Ajoute');
    closeForm();
    loadEvents();
}

async function toggleEvent(id) {
    const stored = lsGetEvents();
    const ev = stored.find(e => e.id === id);
    if (ev) ev.active = !ev.active;
    lsSaveEvents(stored);
    // Update server via PUT
    if (ev) {
        apiCall('/api/events', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ev),
        });
    }
    showToast('Mis a jour');
    loadEvents();
}

async function deleteEvent(id) {
    if (!confirm('Supprimer ?')) return;
    lsSaveEvents(lsGetEvents().filter(e => e.id !== id));
    apiCall(`/api/events?id=${encodeURIComponent(id)}`, { method: 'DELETE' });

    // Nettoyer les logs, alertes et resultats lies a cet evenement
    const state = getMonState();
    const evName = (events.find(e => e.id === id) || {}).name;
    if (evName) {
        state.logs = (state.logs || []).filter(l => !l.message?.includes(evName));
        state.alerts = (state.alerts || []).filter(a => a.event !== evName);
    }
    if (state.last_results) {
        state.last_results = state.last_results.filter(r => r.event !== evName);
    }
    setMonState(state);
    renderMonitorUI();

    showToast('Supprime');
    loadEvents();
}

function clearFormFields() {
    ['eventName','eventVenue','eventSaleDate','eventMarker']
        .forEach(id => document.getElementById(id).value = '');
    document.getElementById('urlsList').innerHTML = '';
    urlFieldCount = 0;
    document.getElementById('datesList').innerHTML = '';
    dateFieldCount = 0;
    addDateField();  // always at least one
    addUrlField(); // Start with one empty URL field
}

// ══════════════════════════════════════
// CHECK HISTORY
// ══════════════════════════════════════

let historyVisible = false;

function toggleHistory() {
    historyVisible = !historyVisible;
    const container = document.getElementById('historyContainer');
    const toggle = document.getElementById('historyToggle');
    container.style.display = historyVisible ? 'block' : 'none';
    toggle.classList.toggle('open', historyVisible);
    if (historyVisible) loadHistory();
}

async function loadHistory() {
    const container = document.getElementById('historyContainer');
    try {
        const res = await fetch(`${API}/api/monitor/history`, { headers: authHeaders() });
        const data = await res.json();
        if (data && Array.isArray(data) && data.length > 0) {
            container.innerHTML = data.map(h => {
                const dotClass = h.status === 'OPEN' || h.status === 'CHANGED' ? 'alert'
                    : h.status === 'ERROR' ? 'error'
                    : h.status === 'CLOSED' ? 'closed'
                    : 'ok';
                const time = h.timestamp ? new Date(h.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                const date = h.timestamp ? new Date(h.timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
                return `
                    <div class="history-item">
                        <span class="history-dot ${dotClass}"></span>
                        <span class="history-time">${date} ${time}</span>
                        <span class="history-event">${esc(h.event || '')}</span>
                        <span class="history-detail">${esc(h.detail || h.status || '')}</span>
                    </div>`;
            }).join('');
        } else {
            container.innerHTML = '';
        }
    } catch {
        container.innerHTML = '<div style="text-align:center;padding:1rem;color:#444;font-size:0.8rem">Impossible de charger l\'historique</div>';
    }
}

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════

function slugify(t) {
    return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function fmtDate(s) {
    if (!s) return '';
    try {
        return new Date(s.replace(' ','T')).toLocaleDateString('fr-FR', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: s.includes(':') ? '2-digit' : undefined,
            minute: s.includes(':') ? '2-digit' : undefined,
        });
    } catch { return s; }
}

function showToast(msg, error = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (error ? ' error' : '');
    setTimeout(() => t.className = 'toast', 2000);
}

// ══════════════════════════════════════
// SCHEDULER
// ══════════════════════════════════════

let schedTimer = null;
let schedTarget = null;
const SCHED_KEY = 'ticket_alert_schedule';

function toggleSchedule() {
    if (schedTarget) {
        cancelSchedule();
    } else {
        const input = document.getElementById('schedTime').value;
        if (!input) { showToast('Choisis une date/heure', true); return; }
        const target = new Date(input);
        if (target <= new Date()) { showToast('L\'heure doit etre dans le futur', true); return; }
        schedTarget = target;
        localStorage.setItem(SCHED_KEY, target.toISOString());
        startCountdown();
        showToast('Demarrage programme');
    }
}

function cancelSchedule() {
    schedTarget = null;
    localStorage.removeItem(SCHED_KEY);
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
    document.getElementById('scheduler').classList.remove('scheduled');
    document.getElementById('schedCountdown').style.display = 'none';
    document.getElementById('schedBtn').textContent = 'Programmer';
    document.getElementById('schedBtn').classList.remove('active');
    document.getElementById('schedTime').disabled = false;
}

function startCountdown() {
    const sched = document.getElementById('scheduler');
    const btn = document.getElementById('schedBtn');
    const cd = document.getElementById('schedCountdown');
    const input = document.getElementById('schedTime');

    sched.classList.add('scheduled');
    btn.textContent = 'Annuler';
    btn.classList.add('active');
    input.disabled = true;
    cd.style.display = 'block';

    if (schedTimer) clearInterval(schedTimer);
    schedTimer = setInterval(() => {
        const now = new Date();
        const diff = schedTarget - now;

        if (diff <= 0) {
            // Time's up — start monitoring!
            cancelSchedule();
            startMonitor();
            showToast('Surveillance demarree automatiquement');
            return;
        }

        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);

        cd.innerHTML = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
            + `<div class="sched-sub">avant demarrage auto</div>`;
    }, 1000);
}

// Restore schedule from localStorage on page load
function restoreSchedule() {
    const saved = localStorage.getItem(SCHED_KEY);
    if (saved) {
        const target = new Date(saved);
        if (target > new Date()) {
            schedTarget = target;
            document.getElementById('schedTime').value = target.toISOString().slice(0, 16);
            startCountdown();
        } else {
            // Time already passed while page was closed — start now!
            localStorage.removeItem(SCHED_KEY);
            startMonitor();
            showToast('Heure programmee atteinte — surveillance lancee');
        }
    } else {
        // Pre-fill with tomorrow 18:00 as default
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(18, 0, 0, 0);
        document.getElementById('schedTime').value = tomorrow.toISOString().slice(0, 16);
    }
}

// ══════════════════════════════════════
// TABS
// ══════════════════════════════════════

async function cleanupEvents() {
    const btn = document.getElementById('btnCleanup');
    btn.disabled = true;
    btn.textContent = 'Nettoyage...';
    try {
        const res = await fetch(`${API}/api/events/cleanup`, {
            method: 'POST',
            headers: authHeaders(),
        });
        const data = await res.json();
        if (data.ok) {
            showToast(data.message);
            loadEvents();
        } else {
            showToast(data.error || 'Erreur', true);
        }
    } catch (e) {
        showToast('Erreur de connexion', true);
    }
    btn.disabled = false;
    btn.textContent = 'Nettoyer';
}

function switchTab(tab) {
    document.getElementById('tabSearch').classList.toggle('active', tab === 'search');
    document.getElementById('tabEvents').classList.toggle('active', tab === 'events');
    document.getElementById('tabCalendar').classList.toggle('active', tab === 'calendar');
    document.getElementById('tabContentSearch').style.display = tab === 'search' ? '' : 'none';
    document.getElementById('tabContentEvents').style.display = tab === 'events' ? '' : 'none';
    document.getElementById('tabContentCalendar').style.display = tab === 'calendar' ? '' : 'none';
    if (tab === 'calendar') renderCalendar();
}

// ══════════════════════════════════════
// AI AGENT SEARCH
// ══════════════════════════════════════

let searchResultsData = [];
let searchResultsType = 'concert';
let searchResultsQuery = '';

async function searchArtist() {
    const input = document.getElementById('searchArtist');
    const artist = input.value.trim();
    if (!artist) { showToast('Entre une recherche', true); return; }

    const btn = document.getElementById('searchBtn');
    const results = document.getElementById('searchResults');
    const loading = document.getElementById('searchLoading');

    btn.disabled = true;
    btn.textContent = '...';
    results.innerHTML = '';
    loading.style.display = '';

    try {
        const res = await fetch(`${API}/api/agent/search`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: artist }),
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Erreur serveur (${res.status})`);
        }
        const data = await res.json();

        loading.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Rechercher';

        if (!data.ok || !data.found) {
            results.innerHTML = `<div class="search-message">${esc(data.message || data.error || 'Aucun resultat')}</div>`;
            return;
        }

        searchResultsData = data.events || data.concerts || [];
        searchResultsType = data.type || 'concert';
        searchResultsQuery = data.query || data.artist || artist;

        if (searchResultsData.length === 0) {
            results.innerHTML = `<div class="search-message">${esc(data.message || 'Aucun resultat')}</div>`;
            return;
        }

        const typeIcons = { concert: '🎤', sport: '⚽', event: '🎫' };
        const typeIcon = typeIcons[searchResultsType] || '🎫';

        results.innerHTML = (data.message ? `<div class="search-message">${esc(data.message)}</div>` : '') +
            searchResultsData.map((c, i) => {
                const dates = (c.dates || []).map(d => fmtDate(d)).join(' · ');
                const statusClass = c.status || 'bientot';
                const statusLabels = { en_vente: 'En vente', prevente: 'Prevente', bientot: 'Bientot', complet: 'Complet' };
                const urlsHtml = (c.ticket_urls || []).map(u =>
                    `<a href="${esc(u.url)}" target="_blank">${esc(u.label || 'Billets')}</a>`
                ).join('');
                const eventName = c.name || data.artist || artist;
                const competition = c.competition ? `<span class="result-competition">${esc(c.competition)}</span>` : '';

                return `
                <div class="search-result-card">
                    <div class="result-artist">${typeIcon} ${esc(eventName)}</div>
                    <div class="result-venue">${esc(c.venue || '')}${c.city ? ' — ' + esc(c.city) : ''}</div>
                    ${competition}
                    ${dates ? `<div class="result-dates">${dates}</div>` : ''}
                    ${c.price_range ? `<div class="result-dates">${esc(c.price_range)}</div>` : ''}
                    <span class="result-status ${statusClass}">${statusLabels[c.status] || c.status || '?'}</span>
                    ${urlsHtml ? `<div class="result-urls">${urlsHtml}</div>` : ''}
                    ${c.status !== 'complet' ? `<button class="btn-add-result" onclick="addFromSearch(${i})">+ Surveiller</button>` : ''}
                </div>`;
            }).join('');

    } catch (e) {
        loading.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Rechercher';
        let msg = 'Une erreur est survenue';
        if (e.name === 'TypeError' || e.message.includes('fetch')) {
            msg = 'Impossible de contacter le serveur. Verifie ta connexion.';
        } else if (e.message.includes('timeout') || e.message.includes('abort')) {
            msg = 'La recherche a pris trop de temps. Reessaie.';
        } else if (e.message) {
            msg = e.message;
        }
        results.innerHTML = `<div class="search-message search-error">${esc(msg)}</div>`;
    }
}

function addFromSearch(index) {
    const c = searchResultsData[index];
    if (!c) return;

    const eventName = c.name || searchResultsQuery;
    const ev = {
        id: slugify(eventName + '-' + (c.venue || '')) + '-' + Date.now().toString(36),
        name: eventName,
        venue: c.venue || '',
        dates: (c.dates || []).map(d => ({ date: d, tickets: 2 })),
        sale_date: c.sale_date || null,
        urls: (c.ticket_urls || []).map(u => ({ url: u.url, label: u.label || '' })),
        url: c.ticket_urls?.[0]?.url || '',
        closed_marker: null,
        active: true,
        type: searchResultsType,
        competition: c.competition || null,
    };

    // Save locally
    const stored = lsGetEvents();
    stored.push(ev);
    lsSaveEvents(stored);

    // Save to API
    apiCall('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
    });

    showToast('Evenement ajoute — voir "Mes evenements"');
    loadEvents();

    // Mark button as added
    const btn = document.querySelectorAll('.btn-add-result')[index];
    if (btn) { btn.textContent = 'Ajoute !'; btn.disabled = true; btn.style.opacity = '0.5'; }

    // Flash the events tab to signal
    const tabBtn = document.getElementById('tabEvents');
    if (tabBtn) { tabBtn.style.color = '#22c55e'; setTimeout(() => tabBtn.style.color = '', 2000); }
}

// Allow Enter key to trigger search
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('searchArtist');
    if (input) {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchArtist();
        });
    }
});

// ══════════════════════════════════════
// CALENDAR VIEW
// ══════════════════════════════════════

let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let calendarSelectedDate = null;

function calendarPrevMonth() {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    calendarSelectedDate = null;
    renderCalendar();
}

function calendarNextMonth() {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    calendarSelectedDate = null;
    renderCalendar();
}

function getEventsForDate(dateStr) {
    return events.filter(ev => {
        const dates = getEventDates(ev);
        return dates.some(d => d.date === dateStr);
    });
}

function getEventTypeClass(ev) {
    const t = (ev.type || '').toLowerCase();
    if (t === 'concert') return 'concert';
    if (t === 'sport') return 'sport';
    return 'other';
}

function renderCalendar() {
    const label = document.getElementById('calendarMonthLabel');
    const grid = document.getElementById('calendarGrid');
    const dayEventsEl = document.getElementById('calendarDayEvents');

    const monthNames = ['Janvier','Fevrier','Mars','Avril','Mai','Juin','Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];
    label.textContent = `${monthNames[calendarMonth]} ${calendarYear}`;

    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7; // Monday=0
    const daysInMonth = lastDay.getDate();

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    const dayHeaders = ['Lu','Ma','Me','Je','Ve','Sa','Di'];
    let html = dayHeaders.map(d => `<div class="calendar-day-header">${d}</div>`).join('');

    // Empty cells before first day
    for (let i = 0; i < startDow; i++) {
        html += '<div class="calendar-day empty"></div>';
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayEvents = getEventsForDate(dateStr);
        const isToday = dateStr === todayStr;
        const isSelected = dateStr === calendarSelectedDate;
        const hasEvent = dayEvents.length > 0;

        let classes = 'calendar-day';
        if (isToday) classes += ' today';
        if (hasEvent) classes += ' has-event';
        if (isSelected) classes += ' selected';

        let dotsHtml = '';
        if (hasEvent) {
            dotsHtml = '<div class="calendar-dots">';
            const shown = dayEvents.slice(0, 3);
            for (const ev of shown) {
                dotsHtml += `<span class="calendar-dot ${getEventTypeClass(ev)}"></span>`;
            }
            dotsHtml += '</div>';
        }

        const onclick = hasEvent ? `onclick="selectCalendarDate('${dateStr}')"` : '';
        html += `<div class="${classes}" ${onclick}>${d}${dotsHtml}</div>`;
    }

    grid.innerHTML = html;

    // Show events for selected date
    if (calendarSelectedDate) {
        const dayEvents = getEventsForDate(calendarSelectedDate);
        if (dayEvents.length > 0) {
            dayEventsEl.innerHTML = dayEvents.map(ev => {
                const typeClass = getEventTypeClass(ev);
                const typeLabel = (ev.type || 'event').charAt(0).toUpperCase() + (ev.type || 'event').slice(1);
                return `
                    <div class="calendar-event-item">
                        <div class="cal-ev-name">${esc(ev.name)}</div>
                        ${ev.venue ? `<div class="cal-ev-venue">${esc(ev.venue)}</div>` : ''}
                        <span class="cal-ev-type ${typeClass}">${esc(typeLabel)}</span>
                    </div>`;
            }).join('');
        } else {
            dayEventsEl.innerHTML = '';
        }
    } else {
        dayEventsEl.innerHTML = '';
    }
}

function selectCalendarDate(dateStr) {
    calendarSelectedDate = calendarSelectedDate === dateStr ? null : dateStr;
    renderCalendar();
}

// ══════════════════════════════════════
// SHARE & EXPORT CALENDAR
// ══════════════════════════════════════

async function shareEvent(id) {
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    const auth = getAuth();

    // Generate share token via API (no PIN in URL)
    let shareUrl;
    try {
        const resp = await fetch('/api/share/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${auth?.pin || ''}`
            },
            body: JSON.stringify({ id })
        });
        const data = await resp.json();
        if (data.ok && data.token) {
            shareUrl = `https://gofindmytickets.vercel.app/api/share?token=${data.token}`;
        } else {
            showToast(data.error || 'Erreur lors du partage');
            return;
        }
    } catch {
        showToast('Erreur lors du partage');
        return;
    }

    const shareData = {
        title: `${ev.name} — goFindMyTickets`,
        text: `Surveille "${ev.name}" sur goFindMyTickets`,
        url: shareUrl,
    };

    if (navigator.share) {
        try {
            await navigator.share(shareData);
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }

    // Fallback: copy to clipboard
    try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Lien copie dans le presse-papier');
    } catch {
        // Last fallback
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Lien copie dans le presse-papier');
    }
}

function exportCalendar(id) {
    const auth = getAuth();
    const calUrl = `https://gofindmytickets.vercel.app/api/calendar?id=${encodeURIComponent(id)}&pin=${encodeURIComponent(auth?.pin || '')}`;
    window.open(calUrl, '_blank');
}

// ══════════════════════════════════════
// SWIPE TO DELETE (mobile)
// ══════════════════════════════════════

function initSwipeToDelete() {
    const cards = document.querySelectorAll('.event-card[data-event-id]');
    cards.forEach(card => {
        let startX = 0;
        let currentX = 0;
        let isSwiping = false;
        const threshold = 80;

        card.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            currentX = 0;
            card.classList.remove('snap-back');
        }, { passive: true });

        card.addEventListener('touchmove', (e) => {
            const diffX = e.touches[0].clientX - startX;
            if (diffX < -10) {
                isSwiping = true;
                card.classList.add('swiping');
                currentX = Math.max(diffX, -120);
                card.style.transform = `translateX(${currentX}px)`;
            }
        }, { passive: true });

        card.addEventListener('touchend', () => {
            card.classList.remove('swiping');
            if (isSwiping) {
                if (currentX < -threshold) {
                    // Trigger delete
                    const evId = card.getAttribute('data-event-id');
                    card.style.transform = `translateX(-100%)`;
                    card.style.transition = 'transform 0.2s ease';
                    setTimeout(() => deleteEvent(evId), 200);
                } else {
                    card.classList.add('snap-back');
                    card.style.transform = '';
                }
            }
            isSwiping = false;
            currentX = 0;
            startX = 0;
        }, { passive: true });
    });
}

// ══════════════════════════════════════
// PULL TO REFRESH (mobile)
// ══════════════════════════════════════

function initPullToRefresh() {
    if (!('ontouchstart' in window)) return;

    const eventsTab = document.getElementById('tabContentEvents');
    const ptr = document.getElementById('pullToRefresh');
    if (!eventsTab || !ptr) return;

    let startY = 0;
    let pulling = false;
    let refreshing = false;

    eventsTab.addEventListener('touchstart', (e) => {
        if (refreshing) return;
        if (window.scrollY > 10) return;
        startY = e.touches[0].clientY;
        pulling = true;
    }, { passive: true });

    eventsTab.addEventListener('touchmove', (e) => {
        if (!pulling || refreshing) return;
        const diffY = e.touches[0].clientY - startY;
        if (diffY > 50 && window.scrollY <= 0) {
            ptr.classList.add('visible');
        }
    }, { passive: true });

    eventsTab.addEventListener('touchend', async () => {
        if (!pulling || refreshing) return;
        pulling = false;
        if (ptr.classList.contains('visible')) {
            refreshing = true;
            await loadEvents();
            setTimeout(() => {
                ptr.classList.remove('visible');
                refreshing = false;
                showToast('Liste actualisee');
            }, 500);
        }
    }, { passive: true });
}

// ══════════════════════════════════════
// NOTIFICATION SETTINGS
// ══════════════════════════════════════

function openSettings() {
    document.getElementById('settingsOverlay').classList.add('open');
    loadSettingsState();
}

function closeSettings() {
    document.getElementById('settingsOverlay').classList.remove('open');
}

function loadSettingsState() {
    const saved = JSON.parse(localStorage.getItem('gfmt_settings') || '{}');
    document.getElementById('settingsTelegram').checked = saved.telegram !== false;
    document.getElementById('settingsQuietEnabled').checked = !!saved.quiet_hours_enabled;
    document.getElementById('settingsQuietStart').value = saved.quiet_hours_start || '22:00';
    document.getElementById('settingsQuietEnd').value = saved.quiet_hours_end || '07:00';
    toggleQuietTimesVisibility();

    document.getElementById('settingsQuietEnabled').addEventListener('change', toggleQuietTimesVisibility);
}

function toggleQuietTimesVisibility() {
    const enabled = document.getElementById('settingsQuietEnabled').checked;
    document.getElementById('quietTimesRow').style.display = enabled ? 'flex' : 'none';
}

async function saveSettings() {
    const settings = {
        telegram: document.getElementById('settingsTelegram').checked,
        quiet_hours_enabled: document.getElementById('settingsQuietEnabled').checked,
        quiet_hours_start: document.getElementById('settingsQuietStart').value,
        quiet_hours_end: document.getElementById('settingsQuietEnd').value,
    };

    localStorage.setItem('gfmt_settings', JSON.stringify(settings));

    // Send to server
    await apiCall('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });

    showToast('Parametres enregistres');
    closeSettings();
}

// ══════════════════════════════════════
// DAYS-UNTIL COUNTDOWN
// ══════════════════════════════════════

function getDaysUntil(ev) {
    const dates = getEventDates(ev);
    const today = new Date(); today.setHours(0,0,0,0);
    let earliest = null;
    for (const d of dates) {
        const dt = new Date(d.date || d);
        if (dt >= today && (!earliest || dt < earliest)) earliest = dt;
    }
    if (!earliest) return null; // all past
    return Math.ceil((earliest - today) / 86400000);
}

function fmtDaysUntil(days) {
    if (days === null) return '<span class="badge badge-past">Termine</span>';
    if (days === 0) return '<span class="badge badge-today">Aujourd\'hui</span>';
    if (days === 1) return '<span class="badge badge-soon">Demain</span>';
    if (days <= 7) return '<span class="badge badge-soon">J-' + days + '</span>';
    if (days <= 30) return '<span class="badge badge-future">J-' + days + '</span>';
    return '<span class="badge badge-future">dans ' + Math.floor(days / 30) + ' mois</span>';
}

// ══════════════════════════════════════
// URL HEALTH
// ══════════════════════════════════════

let urlHealthCache = null;

async function loadUrlHealth() {
    try {
        const data = await apiCall('/api/events/health');
        if (data && data.events) {
            urlHealthCache = {};
            for (const ev of data.events) {
                urlHealthCache[ev.id] = {};
                for (const u of ev.urls) {
                    urlHealthCache[ev.id][u.url] = u.ok;
                }
            }
            renderEvents(); // re-render with health dots
        }
    } catch {}
}

// ══════════════════════════════════════
// CRON HEALTH
// ══════════════════════════════════════

async function loadCronHealth() {
    try {
        const data = await apiCall('/api/monitor/heartbeat');
        const el = document.getElementById('cronIndicator');
        if (!el) return;
        if (data && data.healthy) {
            el.className = 'cron-indicator active';
            el.innerHTML = '<span class="cron-dot"></span>Cron actif';
        } else {
            el.className = 'cron-indicator inactive';
            el.innerHTML = '<span class="cron-dot"></span>Cron inactif';
        }
    } catch {
        const el = document.getElementById('cronIndicator');
        if (el) {
            el.className = 'cron-indicator inactive';
            el.innerHTML = '<span class="cron-dot"></span>Cron inactif';
        }
    }
}

// ══════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════

function showOnboarding() {
    document.getElementById('onboarding').style.display = '';
}

function nextOnboardStep(step) {
    document.querySelectorAll('.onboarding-step').forEach(s => s.style.display = 'none');
    document.getElementById('onboardStep' + step).style.display = '';
}

function closeOnboarding() {
    document.getElementById('onboarding').style.display = 'none';
}

// ══════════════════════════════════════
// OFFLINE MODE
// ══════════════════════════════════════

const OFFLINE_QUEUE_KEY = 'gfmt_offline_queue';

function getOfflineQueue() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)) || []; }
    catch { return []; }
}

function saveOfflineQueue(queue) {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function enqueueAction(action) {
    const queue = getOfflineQueue();
    queue.push({ ...action, timestamp: Date.now() });
    saveOfflineQueue(queue);
}

async function flushOfflineQueue() {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;
    const remaining = [];
    for (const action of queue) {
        try {
            const opts = { method: action.type, headers: { ...authHeaders(), 'Content-Type': 'application/json' } };
            if (action.body) opts.body = JSON.stringify(action.body);
            const res = await fetch(API + action.path, opts);
            if (!res.ok) remaining.push(action);
        } catch {
            remaining.push(action);
            break;
        }
    }
    saveOfflineQueue(remaining);
    if (remaining.length < queue.length) showToast(`${queue.length - remaining.length} action(s) synchronisee(s)`);
}

window.addEventListener('online', () => {
    document.getElementById('offlineBanner').hidden = true;
    flushOfflineQueue();
    loadEvents();
});

window.addEventListener('offline', () => {
    document.getElementById('offlineBanner').hidden = false;
});

// ══════════════════════════════════════
// FAB QUICK SCAN
// ══════════════════════════════════════

async function quickScan() {
    const fab = document.getElementById('fabScan');
    if (fab) fab.classList.add('scanning');
    try {
        const res = await fetch(`${API}/api/monitor/scan`, { headers: authHeaders() });
        const data = await res.json();
        if (data.results) {
            const alerts = data.results.filter(r => r.status === 'OPEN' || r.status === 'CHANGED');
            if (alerts.length > 0) {
                const state = getMonState();
                const now = new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
                for (const r of alerts) {
                    if (!state.alerts) state.alerts = [];
                    state.alerts.push({ time: now, event: r.event, url: r.url, detail: r.detail });
                }
                setMonState(state);
                renderMonitorUI();
                showToast(`${alerts.length} billetterie(s) detectee(s) !`);
                if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
                playAlertSound();
            } else {
                showToast('Aucun changement');
            }
        }
    } catch { showToast('Erreur scan', true); }
    if (fab) fab.classList.remove('scanning');
}

// ══════════════════════════════════════
// INIT
// ══════════════════════════════════════

function initApp() {
    initTheme();
    loadEvents();
    loadUrlHealth();
    loadCronHealth();
    restoreSchedule();
    restorePushState();
    initPullToRefresh();
    const state = getMonState();
    renderMonitorUI();
    if (state.running) {
        startPolling();
        startStatusPolling();
    }
    if (!navigator.onLine) document.getElementById('offlineBanner').hidden = false;
}

// Entry point: check auth first
checkAuth();
