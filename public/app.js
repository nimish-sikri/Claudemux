'use strict';
/* Claudemux renderer */

// ── Theme ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'theme';
const TERM_THEMES = {
  dark: {
    background:    '#0e0e0e',
    foreground:    '#d4d4d4',
    black:         '#1e1e1e', brightBlack:   '#555',
    red:           '#f44747', brightRed:     '#f44747',
    green:         '#6a9955', brightGreen:   '#b5cea8',
    yellow:        '#d7ba7d', brightYellow:  '#d7ba7d',
    blue:          '#569cd6', brightBlue:    '#9cdcfe',
    magenta:       '#c586c0', brightMagenta: '#c586c0',
    cyan:          '#4ec9b0', brightCyan:    '#4ec9b0',
    white:         '#d4d4d4', brightWhite:   '#ffffff',
    cursor:        '#d4d4d4',
    selectionBackground: 'rgba(255,255,255,0.15)',
  },
  light: {
    background:    '#f7f7f9',
    foreground:    '#1f1f24',
    black:         '#1c1c1f', brightBlack:   '#4d4d57',
    red:           '#b3261e', brightRed:     '#8a1a14',
    green:         '#2d7d34', brightGreen:   '#256128',
    yellow:        '#a06400', brightYellow:  '#854f00',
    blue:          '#1a64b8', brightBlue:    '#0e4f95',
    magenta:       '#9d2e9b', brightMagenta: '#7a2479',
    cyan:          '#1e7878', brightCyan:    '#155959',
    white:         '#4d4d57', brightWhite:   '#1c1c1f',
    cursor:        '#1f1f24',
    selectionBackground: 'rgba(0,0,0,0.10)',
  },
};

function currentTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(THEME_KEY, name); } catch {}

  // Terminal stays dark in both modes — claude's diff output uses ANSI escape codes
  // (256-color and hard-coded fg/bg) baked for dark backgrounds. Forcing a light
  // palette only re-tints the 16 ANSI colors, leaving claude's syntax tokens
  // unreadable. So we keep the terminal dark while the rest of the chrome retheme.
  // (Same approach VS Code / JetBrains use for their default light themes.)

  // Push the native window-overlay (Windows min/max/close strip) too
  try {
    window.api.setTitleBarOverlay({
      color:       name === 'light' ? '#ffffff' : '#131316',
      symbolColor: name === 'light' ? '#0e0e10' : '#93939a',
    });
  } catch {}
}


function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Apply persisted theme as early as possible
(() => {
  let t = 'dark';
  try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}
  document.documentElement.dataset.theme = t;
  // Sync title-bar overlay on the next tick (window.api is ready)
  setTimeout(() => {
    try {
      window.api.setTitleBarOverlay({
        color:       t === 'light' ? '#ffffff' : '#131316',
        symbolColor: t === 'light' ? '#0e0e10' : '#93939a',
      });
    } catch {}
  }, 0);
})();

// ── State ─────────────────────────────────────────────────────────────────────
let allSessions   = [];
let sessionsMap   = new Map(); // id -> session object
let activeSession = null;   // { id, cwd, ... }
let terminals     = {};     // sessionId -> Terminal instance
let fitAddons     = {};     // sessionId -> FitAddon
let runningSet    = new Set(); // sessionIds that have an active PTY

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function groupByProject(sessions) {
  const map = {};
  for (const s of sessions) {
    const key = s.projectName || 'Unknown';
    if (!map[key]) map[key] = { name: key, path: s.projectPath, sessions: [] };
    map[key].sessions.push(s);
  }
  return Object.values(map).sort((a, b) => {
    // Sort projects by most-recent session
    const aTs = a.sessions[0]?.lastTs || '';
    const bTs = b.sessions[0]?.lastTs || '';
    return bTs < aTs ? -1 : 1;
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Load sessions ─────────────────────────────────────────────────────────────
async function loadSessions() {
  allSessions = await window.api.getSessions();
  sessionsMap = new Map(allSessions.map(s => [s.id, s]));
  renderSessionList(allSessions);
}

// ── Render session list ───────────────────────────────────────────────────────
const PROJ_OPEN_KEY  = 'proj-open-';
const PROJ_EXP_KEY   = 'proj-expanded-';   // per-project "show all" toggle
function getVisibleRecent() {
  try { return JSON.parse(localStorage.getItem('app-settings') || '{}').sessionsVisible || 5; }
  catch { return 5; }
}
const VISIBLE_RECENT = 5;

function isProjectOpen(name) {
  return sessionStorage.getItem(PROJ_OPEN_KEY + name) !== 'false';
}
function setProjectOpen(name, open) {
  sessionStorage.setItem(PROJ_OPEN_KEY + name, open ? 'true' : 'false');
}
function isProjectExpanded(name) {
  return sessionStorage.getItem(PROJ_EXP_KEY + name) === 'true';
}
function setProjectExpanded(name, expanded) {
  sessionStorage.setItem(PROJ_EXP_KEY + name, expanded ? 'true' : 'false');
}

function renderSessionList(sessions) {
  const list  = $('session-list');
  const query = $('search').value.toLowerCase().trim();
  let shown = query
    ? sessions.filter(s =>
        s.aiTitle.toLowerCase().includes(query) ||
        s.projectName.toLowerCase().includes(query) ||
        s.id.toLowerCase().includes(query) ||
        (s.preview||'').toLowerCase().includes(query))
    : sessions;

  if (pinnedOnly) shown = shown.filter(s => pinnedSet.has(s.id));

  updateSidebarFooter(sessions);

  if (!shown.length) {
    list.innerHTML = query
      ? `<div class="empty-cta"><strong>No matches</strong>Try a different search term, project name, or session id.</div>`
      : `<div class="empty-cta">
           <strong>No sessions yet</strong>
           Run <kbd>claude</kbd> in any folder, or press <kbd>+</kbd> in the toolbar to create your first session.
         </div>`;
    return;
  }

  const groups = groupByProject(shown);
  const pinIconSvg = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 1L8 4 5.2 4.4c-.5.1-.7.7-.3 1L7 7.5l-.7 4c-.1.5.5.9.9.6L10 9.5l3.4 1.7c.5.2 1-.3.7-.7L12 7l1.6-2.2c.3-.4-.1-.9-.5-.9L10.5 1z"/></svg>`;

  let html = '';
  for (const g of groups) {
    const open     = isProjectOpen(g.name);
    const expanded = !!query || isProjectExpanded(g.name);
    const limit    = getVisibleRecent();
    const visible  = expanded ? g.sessions : g.sessions.slice(0, limit);
    const olderN   = g.sessions.length - visible.length;
    html += `
<div class="project-group" data-name="${esc(g.name)}">
  <div class="project-header" data-action="toggle">
    <span class="project-caret ${open ? 'open' : ''}">▶</span>
    <span class="project-name-text" title="${esc(g.path)}">${esc(g.name)}</span>
    <div class="project-actions">
      <button class="icon-btn small" title="Project settings"   data-action="proj-settings">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2"/></svg>
      </button>
      <button class="icon-btn small" title="Archive all"        data-action="proj-archive">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="3"/><rect x="3" y="6" width="10" height="8"/><path d="M6 9h4"/></svg>
      </button>
      <button class="icon-btn small" title="New session here"   data-action="new" data-path="${esc(g.path)}">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
      </button>
    </div>
  </div>
  <div class="project-sessions ${open ? '' : 'collapsed'}">`;

    for (const s of visible) {
      const isActive  = activeSession?.id === s.id;
      const statusCls = s.status;
      const hasRunning = runningSet.has(s.id);
      const needsAttn  = s.status === 'needs-input';
      const msgs      = s.userTurns + s.assistantTurns;
      const isPinned  = isSessionPinned(s.id);
      const displayTitle = getRenamedTitle(s.id) || s.aiTitle;
      const preview = (s.preview || '').trim().slice(0, 80);
      const itemClasses = [
        'session-item',
        isActive   ? 'active'           : '',
        hasRunning ? 'has-running-pty'  : '',
        needsAttn  ? 'needs-attention'  : '',
      ].filter(Boolean).join(' ');
      html += `
    <div class="${itemClasses}" data-id="${esc(s.id)}" title="${esc(s.cwd || '')}">
      <div class="session-row">
        <span class="session-pin ${isPinned ? 'pinned' : ''}" data-action="pin" title="${isPinned ? 'Unpin' : 'Pin'}">${pinIconSvg}</span>
        <span class="session-status-dot ${hasRunning ? 'running' : ''}"></span>
        <div class="session-info">
          <div class="session-summary" data-id="${esc(s.id)}">${esc(displayTitle)}</div>
          ${preview ? `<div class="session-preview">${esc(preview)}</div>` : ''}
          <div class="session-id">${esc(s.id)}</div>
          <div class="session-meta">${esc(s.rel)}${msgs ? ` · ${msgs} msgs` : ''}</div>
        </div>
        <div class="session-actions">
          ${hasRunning ? `<button class="session-stop-btn" data-action="session-stop" title="Stop"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg></button>` : ''}
          <button class="session-more-btn" data-action="session-menu" title="More actions"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg></button>
        </div>
      </div>
    </div>`;
    }
    if (olderN > 0) {
      html += `<button class="show-more-btn" data-action="show-more">+ ${olderN} older</button>`;
    }
    if (expanded && g.sessions.length > limit && !query) {
      html += `<button class="show-more-btn" data-action="show-less">show less</button>`;
    }
    html += `</div></div>`;
  }
  list.innerHTML = html;
}

// ── Pinned sessions ──────────────────────────────────────────────────────────
const PIN_KEY = 'pinned-sessions';
function loadPinnedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]')); }
  catch { return new Set(); }
}
let pinnedSet = loadPinnedSet();
function isSessionPinned(id) { return pinnedSet.has(id); }
function togglePin(id) {
  if (pinnedSet.has(id)) pinnedSet.delete(id);
  else                   pinnedSet.add(id);
  localStorage.setItem(PIN_KEY, JSON.stringify([...pinnedSet]));
  renderSessionList(allSessions);
}

// ── Renamed sessions (override AI title) ─────────────────────────────────────
const RENAME_KEY = 'session-renames';
function loadRenamedMap() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(RENAME_KEY) || '{}'))); }
  catch { return new Map(); }
}
let renamedMap = loadRenamedMap();
function getRenamedTitle(id) { return renamedMap.get(id) || null; }
function setRenamedTitle(id, title) {
  if (title && title.trim()) renamedMap.set(id, title.trim());
  else                       renamedMap.delete(id);
  try { localStorage.setItem(RENAME_KEY, JSON.stringify(Object.fromEntries(renamedMap))); } catch {}
}

function startRename(summaryEl, sessionId) {
  const session = sessionsMap.get(sessionId);
  if (!session) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = getRenamedTitle(sessionId) || session.aiTitle;
  input.spellcheck = false;
  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = () => {
    const v = input.value.trim();
    setRenamedTitle(sessionId, v === session.aiTitle ? null : v);
    const span = document.createElement('div');
    span.className = 'session-summary';
    span.dataset.id = sessionId;
    span.textContent = getRenamedTitle(sessionId) || session.aiTitle;
    input.replaceWith(span);
    // Update topbar if this session is active
    if (activeSession?.id === sessionId) {
      $('topbar-title').textContent = getRenamedTitle(sessionId) || session.aiTitle;
    }
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = session.aiTitle; input.blur(); }
  });
}

function updateSidebarFooter(sessions) {
  const total  = sessions.length;
  const runs   = sessions.filter(s => s.status === 'running').length || runningSet.size;
  const projs  = new Set(sessions.map(s => s.projectName)).size;
  const running = $('sf-running');
  running.textContent = `${runs} running`;
  running.classList.toggle('has-running', runs > 0);
  $('sf-sessions').textContent = `${total} session${total === 1 ? '' : 's'}`;
  $('sf-projects').textContent = `${projs} project${projs === 1 ? '' : 's'}`;
}

// Event delegation for the session list
document.getElementById('session-list').addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const group  = e.target.closest('.project-group');
  const name   = group?.dataset.name;

  if (action === 'new' && name) {
    e.stopPropagation();
    newSessionIn(e.target.closest('[data-action="new"]').dataset.path || '');
    return;
  }
  if (action === 'proj-settings' || action === 'proj-archive') {
    e.stopPropagation();
    // Placeholder for now — could open a project settings modal
    return;
  }
  if (action === 'pin') {
    e.stopPropagation();
    const item = e.target.closest('.session-item');
    if (item?.dataset.id) togglePin(item.dataset.id);
    return;
  }
  if (action === 'session-stop') {
    e.stopPropagation();
    const item = e.target.closest('.session-item');
    if (item?.dataset.id) window.api.killSession({ sessionId: item.dataset.id });
    return;
  }
  if (action === 'show-more' && name) {
    setProjectExpanded(name, true);
    renderSessionList(allSessions);
    return;
  }
  if (action === 'show-less' && name) {
    setProjectExpanded(name, false);
    renderSessionList(allSessions);
    return;
  }
  if (action === 'toggle' && name) {
    setProjectOpen(name, !isProjectOpen(name));
    const sessions = group.querySelector('.project-sessions');
    const caret    = group.querySelector('.project-caret');
    sessions.classList.toggle('collapsed', !isProjectOpen(name));
    caret.classList.toggle('open', isProjectOpen(name));
    return;
  }

  if (action === 'session-menu') {
    e.stopPropagation();
    const item = e.target.closest('.session-item');
    if (item?.dataset.id) showSessionMenu(item.dataset.id, e.clientX, e.clientY);
    return;
  }

  // Session item click
  const item = e.target.closest('.session-item');
  if (item?.dataset.id) openSession(item.dataset.id);
});

// Double-click title to rename
document.getElementById('session-list').addEventListener('dblclick', e => {
  const summary = e.target.closest('.session-summary');
  if (!summary || !summary.dataset.id) return;
  e.stopPropagation();
  startRename(summary, summary.dataset.id);
});

// Right-click context menu on session
document.getElementById('session-list').addEventListener('contextmenu', e => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  e.preventDefault();
  showSessionMenu(item.dataset.id, e.clientX, e.clientY);
});

// Pinned-only filter toggle (toolbar icon)
let pinnedOnly = false;
$('btn-pinned-toggle').addEventListener('click', () => {
  pinnedOnly = !pinnedOnly;
  $('btn-pinned-toggle').classList.toggle('active', pinnedOnly);
  renderSessionList(allSessions);
});

// Collapse-all button in the toolbar
$('btn-collapse-all').addEventListener('click', () => {
  const groups  = new Set(allSessions.map(s => s.projectName));
  // If any are open, close all. Otherwise, open all.
  const anyOpen = [...groups].some(n => isProjectOpen(n));
  for (const n of groups) setProjectOpen(n, !anyOpen);
  renderSessionList(allSessions);
});

function newSessionIn(dirPath) {
  $('new-cwd').value = dirPath || '';
  $('new-session-modal').classList.remove('hidden');
  $('new-cwd').focus();
}

// ── Open session ──────────────────────────────────────────────────────────────
async function openSession(sessionId) {
  const s = sessionsMap.get(sessionId);
  if (!s) return;

  const wasAlreadyMounted = !!terminals[s.id];
  activeSession = s;

  // Update topbar
  $('topbar-title').textContent    = s.aiTitle;
  $('topbar-subtitle').textContent = `Claude Code · ${s.id.slice(0,8)}…`;
  $('top-stat').textContent        = `${s.userTurns + s.assistantTurns} msgs`;
  $('sb-session-id').textContent   = s.id;
  $('sb-cwd').textContent          = s.cwd;
  $('sb-msgs').textContent         = '';
  setStatusDot('top-status-dot', s.status);

  // Highlight in sidebar
  renderSessionList(allSessions);

  // Show terminal (creates one if first time, otherwise just toggles visibility)
  $('terminal-placeholder').classList.add('hidden');
  mountTerminal(s.id);

  // If we already opened this session in this app run, don't spawn a duplicate PTY
  if (wasAlreadyMounted) {
    setTopbarButtons(runningSet.has(s.id) ? 'running' : 'exited');
    return;
  }

  setTopbarButtons('idle');

  // Auto-launch the session (give xterm a frame to size before spawning)
  await new Promise(r => requestAnimationFrame(r));
  const ok = await window.api.launchSession({ sessionId: s.id, cwd: s.cwd, resume: true });
  if (ok) {
    runningSet.add(s.id);
    setTopbarButtons('running');
    const term = terminals[s.id];
    if (term) {
      window.api.resizePty({ sessionId: s.id, cols: term.cols, rows: term.rows });
      term.writeln('\r\n\x1b[2m[Resuming session…]\x1b[0m\r');
    }
  } else {
    $('btn-run').disabled = false;
  }
}

function setStatusDot(id, status) {
  const dot = $(id);
  dot.className = `status-dot ${status}`;
}

function setTopbarButtons(state) {
  if (state === 'running') {
    $('btn-run').disabled     = true;
    $('btn-stop').disabled    = false;
    $('btn-restart').disabled = false;
    $('btn-run').textContent  = '● Running';
    setStatusDot('top-status-dot', 'running');
  } else if (state === 'idle') {
    $('btn-run').disabled     = false;
    $('btn-stop').disabled    = true;
    $('btn-restart').disabled = true;
    $('btn-run').textContent  = '▶ Resume';
    setStatusDot('top-status-dot', activeSession?.status || 'idle');
  } else if (state === 'exited') {
    $('btn-run').disabled     = false;
    $('btn-stop').disabled    = true;
    $('btn-restart').disabled = false;
    $('btn-run').textContent  = '▶ Resume';
    setStatusDot('top-status-dot', 'idle');
  }
}

// ── Terminal management ───────────────────────────────────────────────────────
const termContainers = {}; // sessionId -> div element

function mountTerminal(sessionId, opts = {}) {
  const host = $('terminal-host');
  const { skipWelcome = false } = opts;

  // Hide every other session's terminal
  for (const id in termContainers) {
    termContainers[id].classList.toggle('hidden-term', id !== sessionId);
  }

  // If already mounted, just show its existing container and refit
  if (terminals[sessionId]) {
    requestAnimationFrame(() => {
      fitAddons[sessionId].fit();
      terminals[sessionId].focus();
      window.api.resizePty({
        sessionId,
        cols: terminals[sessionId].cols,
        rows: terminals[sessionId].rows,
      });
    });
    return;
  }

  // Create new xterm instance
  const term = new Terminal({
    fontFamily:  "'Cascadia Code', 'Fira Code', Consolas, monospace",
    fontSize:    13,
    lineHeight:  1.45,
    theme: TERM_THEMES.dark,   // terminal always uses dark palette (see applyTheme note)
    scrollback:    5000,
    cursorBlink:   true,
    allowProposedApi: true,
    // OSC 8 — clickable hyperlinks emitted by claude with explicit URI labels
    linkHandler: {
      activate: (_, text) => {
        if (text.startsWith('file://')) {
          const isWin = navigator.platform.toLowerCase().includes('win');
          openFile(decodeURIComponent(text.replace(/^file:\/+/, isWin ? '' : '/')));
        } else {
          window.api.openExternal({ url: text });
        }
      },
      hover: () => {},
      leave: () => {},
    },
  });

  // The UMD wrappers expose the namespace; the constructor lives on `.<Name>`
  const FitAddonCtor      = (typeof FitAddon === 'function')      ? FitAddon      : FitAddon?.FitAddon;
  const WebLinksAddonCtor = (typeof WebLinksAddon === 'function') ? WebLinksAddon : WebLinksAddon?.WebLinksAddon;
  const SearchAddonCtor   = (typeof SearchAddon === 'function')   ? SearchAddon   : SearchAddon?.SearchAddon;

  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  try {
    if (WebLinksAddonCtor) {
      const linkAddon = new WebLinksAddonCtor((_, url) => window.api.openExternal({ url }));
      term.loadAddon(linkAddon);
    }
  } catch {}
  try {
    if (SearchAddonCtor) {
      const searchAddon = new SearchAddonCtor();
      term.loadAddon(searchAddon);
      searchAddons[sessionId] = searchAddon;
    }
  } catch {}

  terminals[sessionId] = term;
  fitAddons[sessionId] = fitAddon;

  // Per-session container so we can swap visibility without re-opening xterm
  const container = document.createElement('div');
  container.className = 'term-instance';
  container.dataset.id = sessionId;
  host.appendChild(container);
  termContainers[sessionId] = container;

  term.open(container);

  // Defer fit so the container has real pixel dimensions
  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
    if (!skipWelcome) {
      term.writeln('\r\x1b[2m' + '─'.repeat(60) + '\x1b[0m');
      term.writeln(` \x1b[1mClaudemux\x1b[0m — session ${sessionId.slice(0,8)}`);
      term.writeln(' Press \x1b[1mResume\x1b[0m to start.');
      term.writeln('\r\x1b[2m' + '─'.repeat(60) + '\x1b[0m\r');
    }
  });

  // Send keyboard input to PTY
  term.onData(data => {
    if (runningSet.has(sessionId)) {
      window.api.sendInput({ sessionId, data });
    }
  });

  // Clipboard shortcuts — intercept BEFORE xterm consumes the key.
  //   Ctrl+Shift+C   → copy selection (or Cmd+C / Cmd+Shift+C on Mac)
  //   Ctrl+Shift+V   → paste from clipboard (or Cmd+V on Mac)
  //   Ctrl+Insert    → copy (legacy Windows convention)
  //   Shift+Insert   → paste (legacy Windows convention)
  // Returning `false` tells xterm to swallow the event; we also preventDefault
  // so the browser layer doesn't pick it up either.
  const doCopy = () => {
    const sel = term.getSelection();
    if (sel) window.api.clipboardWrite(sel);
  };
  const doPaste = async () => {
    try {
      const text = await window.api.clipboardRead();
      if (text && runningSet.has(sessionId)) {
        window.api.sendInput({ sessionId, data: text });
      }
    } catch {}
  };

  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Copy
    if ((mod && e.shiftKey && key === 'c') ||
        (mod && key === 'c' && term.hasSelection?.()) ||
        (e.ctrlKey && e.key === 'Insert')) {
      doCopy();
      e.preventDefault();
      return false;
    }
    // Paste
    if ((mod && e.shiftKey && key === 'v') ||
        (e.metaKey && key === 'v') ||
        (e.shiftKey && e.key === 'Insert')) {
      doPaste();
      e.preventDefault();
      return false;
    }
    return true;
  });

  // Right-click in the terminal:
  //   - text selected → copy it
  //   - no selection  → paste from clipboard
  container.addEventListener('contextmenu', async e => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) {
      window.api.clipboardWrite(sel);
      term.clearSelection();
    } else if (runningSet.has(sessionId)) {
      const text = await window.api.clipboardRead();
      if (text) window.api.sendInput({ sessionId, data: text });
    }
  });
}

// ── PTY data / events ─────────────────────────────────────────────────────────
// Per-session text tail buffer — keeps last ~30 lines for grid card snapshots
const TAIL_MAX_LINES = 30;
const sessionTails = new Map();
function appendToTail(sessionId, raw) {
  const clean = String(raw).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  if (!clean) return;
  const prev = sessionTails.get(sessionId) || '';
  const lines = (prev + clean).split('\n');
  while (lines.length > TAIL_MAX_LINES) lines.shift();
  sessionTails.set(sessionId, lines.join('\n'));
}
function readTail(sessionId) {
  return sessionTails.get(sessionId) || '';
}

window.api.onPtyData(({ sessionId, data }) => {
  const term = terminals[sessionId];
  if (term) term.write(data);
  appendToTail(sessionId, data);

  // Update status bar with last output snippet
  if (activeSession?.id === sessionId) {
    const clean = String(data).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 80);
    if (clean) $('sb-msgs').textContent = clean;
  }
});

window.api.onSessionExit(({ sessionId, code }) => {
  runningSet.delete(sessionId);
  const term = terminals[sessionId];
  if (term) {
    term.writeln(`\r\n\x1b[2m[Session exited with code ${code}]\x1b[0m\r`);
  }
  if (activeSession?.id === sessionId) {
    setTopbarButtons('exited');
  }
  // Refresh session list to clear running indicator
  loadSessions();
});

// ── Resize terminal on window resize ─────────────────────────────────────────
const resizeObs = new ResizeObserver(() => {
  if (!activeSession) return;
  const fa = fitAddons[activeSession.id];
  if (!fa) return;
  try {
    fa.fit();
    const term = terminals[activeSession.id];
    if (term) {
      window.api.resizePty({ sessionId: activeSession.id, cols: term.cols, rows: term.rows });
    }
  } catch {}
});
resizeObs.observe($('terminal-host'));

// ── Topbar buttons ────────────────────────────────────────────────────────────
$('btn-run').addEventListener('click', async () => {
  if (!activeSession) return;
  const ok = await window.api.launchSession({
    sessionId: activeSession.id,
    cwd:       activeSession.cwd,
    resume:    true,
  });
  if (ok) {
    runningSet.add(activeSession.id);
    setTopbarButtons('running');
    const term = terminals[activeSession.id];
    if (term) term.writeln('\r\n\x1b[2m[Session started — resuming conversation]\x1b[0m\r');
    loadSessions();
  } else {
    const term = terminals[activeSession.id];
    if (term) term.writeln('\r\n\x1b[31m[Could not start session — is Claude Code installed?]\x1b[0m\r');
  }
});

$('btn-stop').addEventListener('click', async () => {
  if (!activeSession) return;
  await window.api.killSession({ sessionId: activeSession.id });
  runningSet.delete(activeSession.id);
  setTopbarButtons('idle');
});

$('btn-restart').addEventListener('click', async () => {
  if (!activeSession) return;
  await window.api.killSession({ sessionId: activeSession.id });
  runningSet.delete(activeSession.id);
  await new Promise(r => setTimeout(r, 300));
  const ok = await window.api.launchSession({
    sessionId: activeSession.id,
    cwd:       activeSession.cwd,
    resume:    true,
  });
  if (ok) {
    runningSet.add(activeSession.id);
    setTopbarButtons('running');
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
$('search').addEventListener('input', () => renderSessionList(allSessions));

// ── Refresh ───────────────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', loadSessions);

// ── New session modal ─────────────────────────────────────────────────────────
$('btn-new-session').addEventListener('click', () => {
  $('new-cwd').value = '';
  $('new-session-modal').classList.remove('hidden');
  setTimeout(() => $('new-cwd').focus(), 50);
});

$('btn-cancel-new').addEventListener('click', () => {
  $('new-session-modal').classList.add('hidden');
});

$('btn-confirm-new').addEventListener('click', async () => {
  const cwd = $('new-cwd').value.trim();
  $('new-session-modal').classList.add('hidden');

  // Generate a placeholder session entry (will be populated after launch)
  const fakeId = 'new-' + Date.now();
  const fakeSession = {
    id: fakeId, cwd: cwd || process.env.HOME || process.env.USERPROFILE,
    aiTitle: 'New Session', projectName: cwd.split(/[/\\]/).pop() || 'project',
    projectPath: cwd, rel: 'just now', userTurns: 0, assistantTurns: 0, status: 'idle',
  };

  activeSession = fakeSession;
  $('terminal-placeholder').classList.add('hidden');
  mountTerminal(fakeId);
  $('btn-run').disabled = false;
  $('topbar-title').textContent    = 'New Session';
  $('topbar-subtitle').textContent = `Claude Code · new`;

  const ok = await window.api.launchSession({ sessionId: fakeId, cwd: fakeSession.cwd, resume: false });
  if (ok) {
    runningSet.add(fakeId);
    setTopbarButtons('running');
  }
});

$('new-cwd').addEventListener('keydown', e => {
  if (e.key === 'Enter')  $('btn-confirm-new').click();
  if (e.key === 'Escape') $('btn-cancel-new').click();
});

$('new-session-modal').addEventListener('click', e => {
  if (e.target === $('new-session-modal')) $('btn-cancel-new').click();
});

// ── Tab routing ───────────────────────────────────────────────────────────────
let currentTab = 'sessions';
const TAB_TO_SIDEBAR = {
  sessions: 'sidebar-sessions',
  plans:    'sidebar-plans',
  memory:   'sidebar-memory',
  stats:    'sidebar-stats',
};
const TAB_TO_VIEW = {
  sessions: 'view-sessions',
  plans:    'view-plans',
  memory:   'view-memory',
  stats:    'view-stats',
};

function switchTab(tabName) {
  if (!TAB_TO_SIDEBAR[tabName]) return;
  currentTab = tabName;

  for (const t of document.querySelectorAll('.sidebar-tabs .tab')) {
    t.classList.toggle('active', t.dataset.tab === tabName);
  }
  for (const id of Object.values(TAB_TO_SIDEBAR)) {
    $(id).classList.toggle('hidden', id !== TAB_TO_SIDEBAR[tabName]);
  }
  for (const id of Object.values(TAB_TO_VIEW)) {
    $(id).classList.toggle('hidden', id !== TAB_TO_VIEW[tabName]);
  }
  $('view-grid').classList.add('hidden');

  if (tabName === 'plans')  loadPlans();
  if (tabName === 'memory') loadMemoryFiles();
  if (tabName === 'stats')  loadStats();
  if (tabName === 'sessions' && activeSession) {
    const fa = fitAddons[activeSession.id];
    if (fa) requestAnimationFrame(() => { try { fa.fit(); } catch {} });
  }
}

document.querySelectorAll('.sidebar-tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Settings button is wired further down to open the Settings dialog
// (Shift+click toggles theme directly as a power-user shortcut.)

// ── Plans ────────────────────────────────────────────────────────────────────
let plansList = [];
let activePlanPath = null;
let planDirty = false;

async function loadPlans() {
  plansList = await window.api.listPlans();
  renderPlanList();
}

function renderPlanList() {
  const q = $('search-plans').value.toLowerCase().trim();
  const shown = q ? plansList.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.projectName || '').toLowerCase().includes(q)) : plansList;
  if (!shown.length) {
    $('plan-list').innerHTML = q
      ? `<div class="empty-cta"><strong>No matches</strong>Try a different search.</div>`
      : `<div class="empty-cta">
           <strong>No plans yet</strong>
           Plans are markdown files in <kbd>.claude/plans/</kbd>. Click <kbd>+</kbd> above to make one.
         </div>`;
    return;
  }
  $('plan-list').innerHTML = shown.map(p => `
    <div class="plan-item ${activePlanPath === p.path ? 'active' : ''}" data-path="${esc(p.path)}">
      <div class="plan-item-title">${esc(p.name.replace(/\.md$/, ''))}</div>
      <div class="plan-item-meta">${esc(p.projectName || '')} · ${relTimeFromIso(p.mtime)}</div>
    </div>`).join('');
}

function relTimeFromIso(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)     return `${s}s ago`;
  if (s < 3600)   return `${Math.floor(s/60)}m ago`;
  if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

$('plan-list').addEventListener('click', async e => {
  const item = e.target.closest('.plan-item');
  if (!item) return;
  if (planDirty && !confirm('Discard unsaved changes?')) return;
  const filePath = item.dataset.path;
  activePlanPath = filePath;
  const content = await window.api.readPlan({ filePath });
  $('plan-editor').value = content || '';
  $('plan-editor').disabled = false;
  $('btn-plan-save').disabled = true;
  $('btn-plan-delete').disabled = false;
  $('plan-title').textContent = filePath.split(/[/\\]/).pop().replace(/\.md$/, '');
  $('plan-subtitle').textContent = filePath;
  planDirty = false;
  renderPlanList();
});

$('plan-editor').addEventListener('input', () => {
  if (!planDirty) {
    planDirty = true;
    $('btn-plan-save').disabled = false;
  }
});

$('btn-plan-save').addEventListener('click', async () => {
  if (!activePlanPath) return;
  const ok = await window.api.writePlan({ filePath: activePlanPath, content: $('plan-editor').value });
  if (ok) { planDirty = false; $('btn-plan-save').disabled = true; loadPlans(); }
});

$('btn-plan-delete').addEventListener('click', async () => {
  if (!activePlanPath || !confirm(`Delete this plan?\n${activePlanPath}`)) return;
  const ok = await window.api.deletePlan({ filePath: activePlanPath });
  if (ok) {
    activePlanPath = null;
    $('plan-editor').value = '';
    $('plan-editor').disabled = true;
    $('btn-plan-save').disabled = true;
    $('btn-plan-delete').disabled = true;
    $('plan-title').textContent = 'Plans';
    $('plan-subtitle').textContent = 'Select a plan to edit';
    loadPlans();
  }
});

$('btn-new-plan').addEventListener('click', async () => {
  const name = prompt('Plan name:', 'untitled-plan');
  if (!name) return;
  const res = await window.api.newPlan({ projectPath: null, name });
  if (res.ok) { await loadPlans(); }
  else        { alert('Could not create plan: ' + (res.error || 'unknown')); }
});

$('btn-refresh-plans').addEventListener('click', loadPlans);
$('search-plans').addEventListener('input', renderPlanList);

// ── Memory ────────────────────────────────────────────────────────────────────
let memoryList = [];
let activeMemoryPath = null;
let memoryDirty = false;

async function loadMemoryFiles() {
  memoryList = await window.api.listMemory();
  renderMemoryList();
}

function renderMemoryList() {
  if (!memoryList.length) {
    $('memory-list').innerHTML = `
      <div class="empty-cta">
        <strong>No CLAUDE.md files found</strong>
        Drop a <kbd>CLAUDE.md</kbd> in any of your project folders and refresh.
      </div>`;
    return;
  }
  $('memory-list').innerHTML = memoryList.map(m => `
    <div class="memory-item ${activeMemoryPath === m.path ? 'active' : ''} ${m.exists ? '' : 'missing'}" data-path="${esc(m.path)}">
      <div class="memory-item-title">${esc(m.name)} <span class="scope-tag">${m.scope}</span></div>
      <div class="memory-item-meta">${esc(m.path)}</div>
    </div>`).join('');
}

$('memory-list').addEventListener('click', async e => {
  const item = e.target.closest('.memory-item');
  if (!item) return;
  if (memoryDirty && !confirm('Discard unsaved changes?')) return;
  const filePath = item.dataset.path;
  activeMemoryPath = filePath;
  const content = await window.api.readMemory({ filePath });
  $('memory-editor').value = content || '';
  $('memory-editor').disabled = false;
  $('btn-memory-save').disabled = true;
  $('memory-title').textContent = filePath.split(/[/\\]/).pop();
  $('memory-subtitle').textContent = filePath;
  memoryDirty = false;
  renderMemoryList();
});

$('memory-editor').addEventListener('input', () => {
  if (!memoryDirty) {
    memoryDirty = true;
    $('btn-memory-save').disabled = false;
  }
});

$('btn-memory-save').addEventListener('click', async () => {
  if (!activeMemoryPath) return;
  const ok = await window.api.writeMemory({ filePath: activeMemoryPath, content: $('memory-editor').value });
  if (ok) { memoryDirty = false; $('btn-memory-save').disabled = true; loadMemoryFiles(); }
});

$('btn-refresh-memory').addEventListener('click', loadMemoryFiles);

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await window.api.getStats();
  renderStats(s);
}

function renderStats(s) {
  $('stats-side').innerHTML = `
    <div class="stat-row"><span>Sessions</span><span>${s.totalSessions}</span></div>
    <div class="stat-row"><span>Projects</span><span>${s.totalProjects}</span></div>
    <div class="stat-row"><span>Est. messages</span><span>${s.totalMessages}</span></div>
    <div class="stat-row"><span>Active days</span><span>${Object.keys(s.perDay).length}</span></div>
  `;

  // Activity heatmap: last 26 weeks (182 days)
  const days = 182;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Start from Sunday of the week containing (today - days)
  const start = new Date(today.getTime() - days * 86400_000);
  start.setDate(start.getDate() - start.getDay());

  const maxCount = Math.max(1, ...Object.values(s.perDay));
  const cells = [];
  let cur = new Date(start);
  while (cur <= today) {
    const key = cur.toISOString().slice(0, 10);
    const n   = s.perDay[key] || 0;
    let level = 0;
    if (n > 0) {
      const p = n / maxCount;
      level = p > 0.75 ? 4 : p > 0.5 ? 3 : p > 0.25 ? 2 : 1;
    }
    cells.push({ date: key, n, level });
    cur = new Date(cur.getTime() + 86400_000);
  }
  const heatHtml = cells.map(c =>
    `<div class="heatmap-cell ${c.level ? 'l' + c.level : ''}" title="${c.date}: ${c.n} session${c.n===1?'':'s'}"></div>`
  ).join('');

  // Project breakdown
  const projs = Object.entries(s.perProject)
    .filter(([_, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxProj = Math.max(1, ...projs.map(([, n]) => n));
  const projHtml = projs.map(([name, n]) => `
    <div class="proj-bar-row">
      <span class="proj-bar-name" title="${esc(name)}">${esc(name)}</span>
      <span class="proj-bar-track"><span class="proj-bar-fill" style="width:${(n/maxProj*100).toFixed(1)}%"></span></span>
      <span class="proj-bar-count">${n}</span>
    </div>`).join('');

  $('stats-main').innerHTML = `
    <div class="stats-card">
      <h3>Overview</h3>
      <div class="stats-numbers">
        <div class="big"><div class="n">${s.totalSessions}</div><div class="l">total sessions</div></div>
        <div class="big"><div class="n">${s.totalProjects}</div><div class="l">projects</div></div>
        <div class="big"><div class="n">${Object.keys(s.perDay).length}</div><div class="l">active days</div></div>
        <div class="big"><div class="n">${s.totalMessages}</div><div class="l">est. messages</div></div>
      </div>
    </div>
    <div class="stats-card">
      <h3>Activity — last 26 weeks</h3>
      <div class="heatmap">${heatHtml}</div>
      <div class="heatmap-legend">
        Less
        <span class="hm-swatch heatmap-cell"></span>
        <span class="hm-swatch heatmap-cell l1"></span>
        <span class="hm-swatch heatmap-cell l2"></span>
        <span class="hm-swatch heatmap-cell l3"></span>
        <span class="hm-swatch heatmap-cell l4"></span>
        More
      </div>
    </div>
    <div class="stats-card">
      <h3>Sessions per project</h3>
      ${projHtml || '<div class="empty">No projects yet.</div>'}
    </div>`;
}

// ── Grid overview ─────────────────────────────────────────────────────────────
$('btn-grid-toggle').addEventListener('click', () => {
  for (const id of Object.values(TAB_TO_VIEW)) $(id).classList.add('hidden');
  $('view-grid').classList.remove('hidden');
  renderGrid();
});
$('btn-grid-back').addEventListener('click', () => {
  switchTab(currentTab);
});

function renderGrid() {
  const wrap = $('grid-wrap');
  // Include any session with a tail buffer OR a mounted terminal
  const idSet = new Set([...Object.keys(terminals), ...sessionTails.keys()]);
  const ids = [...idSet];
  if (!ids.length) {
    wrap.innerHTML = `<div class="empty-cta" style="grid-column:1/-1">
      <strong>No active sessions</strong>
      Open a session from the Sessions tab to see it here.
    </div>`;
    return;
  }
  wrap.innerHTML = ids.map(id => {
    const s = sessionsMap.get(id) || { aiTitle: 'Session', projectName: '' };
    const term = terminals[id];
    let snippet = readTail(id);
    if (!snippet && term) {
      try {
        const buf = term.buffer.active;
        const start = Math.max(0, buf.length - 16);
        const lines = [];
        for (let i = start; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (ln) lines.push(ln.translateToString(true));
        }
        snippet = lines.join('\n');
      } catch {}
    }
    // Show last ~16 lines only in the card
    const lastLines = snippet.split('\n').slice(-16).join('\n').trimEnd();
    const running   = runningSet.has(id);
    const title     = getRenamedTitle(id) || s.aiTitle;
    return `
      <div class="grid-card" data-id="${esc(id)}">
        <div class="grid-card-header">
          <span class="status-dot ${running ? 'running' : 'idle'}"></span>
          <span class="grid-card-title">${esc(title)}</span>
          <span class="grid-card-proj">${esc(s.projectName || '')}</span>
        </div>
        <div class="grid-card-body">${lastLines ? esc(lastLines) : '<div class="grid-card-empty">(no output yet)</div>'}</div>
      </div>`;
  }).join('');
}
$('grid-wrap').addEventListener('click', e => {
  const card = e.target.closest('.grid-card');
  if (!card) return;
  $('view-grid').classList.add('hidden');
  switchTab('sessions');
  openSession(card.dataset.id);
});
// Refresh grid snapshots while it's visible — faster (1s) for liveness
setInterval(() => {
  if (!$('view-grid').classList.contains('hidden')) renderGrid();
}, 1000);

// ── Find-in-terminal (Ctrl+F) ────────────────────────────────────────────────
let searchAddons = {}; // sessionId -> SearchAddon
function getSearchAddonCtor() {
  return (typeof SearchAddon === 'function') ? SearchAddon : SearchAddon?.SearchAddon;
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (currentTab !== 'sessions') return;
    if (!activeSession || !terminals[activeSession.id]) return;
    e.preventDefault();
    $('find-bar').classList.remove('hidden');
    $('find-input').focus();
    $('find-input').select();
  }
});
$('find-close').addEventListener('click', () => $('find-bar').classList.add('hidden'));
$('find-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('find-bar').classList.add('hidden'); return; }
  if (e.key === 'Enter') {
    if (e.shiftKey) doFind('prev'); else doFind('next');
  }
});
$('find-next').addEventListener('click', () => doFind('next'));
$('find-prev').addEventListener('click', () => doFind('prev'));

function doFind(dir) {
  if (!activeSession) return;
  const addon = searchAddons[activeSession.id];
  if (!addon) return;
  const term  = $('find-input').value;
  if (!term) return;
  try { dir === 'next' ? addon.findNext(term) : addon.findPrevious(term); } catch (err) { console.warn(err); }
}

// ── Diff viewer ──────────────────────────────────────────────────────────────
let currentFileMode = 'source';
let currentFilePath = null;
let currentFileContent = null;
let currentFileGitBase = null; // last committed version, if available

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setFileMode(btn.dataset.mode));
});

function setFileMode(mode) {
  currentFileMode = mode;
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  if (!currentFileContent) return;
  if (mode === 'source') {
    $('file-content').classList.remove('hidden');
    $('diff-side-wrap').classList.add('hidden');
    $('file-content').innerHTML = syntaxHighlight(currentFileContent, currentFilePath);
  } else if (mode === 'diff-inline') {
    $('file-content').classList.remove('hidden');
    $('diff-side-wrap').classList.add('hidden');
    $('file-content').innerHTML = renderInlineDiff(currentFileGitBase || '', currentFileContent);
  } else if (mode === 'diff-side') {
    $('file-content').classList.add('hidden');
    $('diff-side-wrap').classList.remove('hidden');
    $('diff-left').innerHTML  = esc(currentFileGitBase || '');
    $('diff-right').innerHTML = esc(currentFileContent);
  }
}

// Naive LCS-ish diff for visualization (good enough for review)
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j])      { out.push({ t: 'eq',  v: A[i] }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ t: 'del', v: A[i] }); i++; }
    else                               { out.push({ t: 'add', v: B[j] }); j++; }
  }
  while (i < m) out.push({ t: 'del', v: A[i++] });
  while (j < n) out.push({ t: 'add', v: B[j++] });
  return out;
}

function renderInlineDiff(base, head) {
  const d = diffLines(base, head);
  return d.map(line => {
    const t = esc(line.v);
    if (line.t === 'add') return `<span class="diff-add">+ ${t}</span>`;
    if (line.t === 'del') return `<span class="diff-del">- ${t}</span>`;
    return `<span>  ${t}</span>`;
  }).join('\n');
}

// ── Resize panel drag ─────────────────────────────────────────────────────────
const handle      = $('resize-handle');
const filePanel   = $('file-panel');
let dragging      = false;
let dragStartX    = 0;
let dragStartW    = 0;

handle.addEventListener('mousedown', e => {
  if (filePanel.classList.contains('hidden')) return;
  dragging   = true;
  dragStartX = e.clientX;
  dragStartW = filePanel.offsetWidth;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const delta = dragStartX - e.clientX;
  const newW  = Math.max(200, Math.min(800, dragStartW + delta));
  filePanel.style.width = newW + 'px';
  if (activeSession) {
    const fa = fitAddons[activeSession.id];
    if (fa) try { fa.fit(); } catch {}
  }
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  handle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ── File panel ────────────────────────────────────────────────────────────────
$('btn-close-file').addEventListener('click', () => {
  $('file-panel').classList.add('hidden');
  if (activeSession) {
    const fa = fitAddons[activeSession.id];
    if (fa) try { fa.fit(); } catch {}
  }
});

async function openFile(filePath) {
  const content = await window.api.readFile({ filePath });
  if (content == null) return;

  currentFilePath    = filePath;
  currentFileContent = content;
  currentFileGitBase = null; // could be wired to git later
  $('file-panel').classList.remove('hidden');
  $('file-tab-name').textContent = filePath.split(/[/\\]/).pop();
  setFileMode('source');

  if (activeSession) {
    const fa = fitAddons[activeSession.id];
    if (fa) try { fa.fit(); } catch {}
  }
}

// Basic syntax highlight (JS/Python/JSON)
function syntaxHighlight(code, filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  let html = esc(code);

  // Diff view
  if (ext === 'diff' || ext === 'patch' || code.startsWith('diff --git')) {
    return html.split('\n').map(l => {
      if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="diff-add">${l}</span>`;
      if (l.startsWith('-') && !l.startsWith('---')) return `<span class="diff-del">${l}</span>`;
      if (l.startsWith('@@'))                         return `<span class="diff-hdr">${l}</span>`;
      return l;
    }).join('\n');
  }

  const kw = {
    js:   ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','typeof','instanceof'],
    py:   ['def','class','import','from','return','if','elif','else','for','while','in','not','and','or','True','False','None','with','as','try','except','finally','raise','yield','lambda'],
    json: [],
  };
  const lang = { js: 'js', ts: 'js', mjs: 'js', cjs: 'js', py: 'py', json: 'json', jsonl: 'json' }[ext];

  if (!lang) return html;

  // Comments
  if (lang === 'js')  html = html.replace(/(\/\/.*?)($)/gm, '<span class="tok-cmt">$1</span>$2');
  if (lang === 'py')  html = html.replace(/(#.*?)($)/gm, '<span class="tok-cmt">$1</span>$2');

  // Strings (simple)
  html = html.replace(/(&quot;.*?&quot;|&#039;.*?&#039;|`.*?`)/g, '<span class="tok-str">$1</span>');

  // Numbers
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-num">$1</span>');

  // Keywords
  for (const word of (kw[lang] || [])) {
    html = html.replace(
      new RegExp(`\\b(${word})\\b`, 'g'),
      '<span class="tok-kw">$1</span>'
    );
  }

  return html;
}

// ── Context menu ─────────────────────────────────────────────────────────────
let _ctxMenuOpenForId = null;

function showSessionMenu(sessionId, x, y) {
  const session = sessionsMap.get(sessionId);
  if (!session) return;
  _ctxMenuOpenForId = sessionId;
  const menu = $('context-menu');
  const isRunning = runningSet.has(sessionId);
  const isPinned  = isSessionPinned(sessionId);

  menu.innerHTML = `
    <div class="context-menu-item" data-act="open">Open<span class="context-menu-shortcut">↵</span></div>
    <div class="context-menu-item" data-act="rename">Rename…<span class="context-menu-shortcut">F2</span></div>
    <div class="context-menu-item" data-act="pin">${isPinned ? 'Unpin' : 'Pin'}</div>
    <div class="context-menu-sep"></div>
    <div class="context-menu-item" data-act="view-jsonl">View messages…</div>
    <div class="context-menu-item" data-act="reveal">Reveal in Explorer</div>
    <div class="context-menu-sep"></div>
    ${isRunning ? '<div class="context-menu-item" data-act="stop">Stop session</div>' : ''}
    <div class="context-menu-item danger" data-act="delete">Delete session…</div>
  `;
  // Position with overflow guard
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth  - rect.width  - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = px + 'px';
  menu.style.top  = py + 'px';
}

function hideContextMenu() {
  $('context-menu').classList.add('hidden');
  _ctxMenuOpenForId = null;
}

document.getElementById('context-menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !_ctxMenuOpenForId) return;
  const id = _ctxMenuOpenForId;
  hideContextMenu();

  if (act === 'open')   return openSession(id);
  if (act === 'pin')    return togglePin(id);
  if (act === 'stop')   { await window.api.killSession({ sessionId: id }); return; }
  if (act === 'rename') {
    const summary = document.querySelector(`.session-summary[data-id="${CSS.escape(id)}"]`);
    if (summary) startRename(summary, id);
    return;
  }
  if (act === 'reveal') {
    const s = sessionsMap.get(id);
    if (s?.cwd) window.api.revealInExplorer?.({ path: s.cwd });
    return;
  }
  if (act === 'view-jsonl') return openJsonlViewer(id);
  if (act === 'delete') {
    if (!confirm('Delete this session’s transcript permanently? This cannot be undone.')) return;
    const ok = await window.api.deleteSession?.({ sessionId: id });
    if (ok) {
      showToast({ title: 'Deleted', body: 'Session transcript removed.' });
      loadSessions();
    } else {
      showToast({ title: 'Delete failed', body: 'Could not remove file.', kind: 'error' });
    }
  }
});

document.addEventListener('click', e => {
  if (!$('context-menu').classList.contains('hidden') &&
      !e.target.closest('#context-menu')) {
    hideContextMenu();
  }
});

// ── Toasts ───────────────────────────────────────────────────────────────────
function showToast({ title, body, kind, ttl = 5000, onClick }) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = `<div class="toast-title">${esc(title || '')}</div>${body ? `<div class="toast-body">${esc(body)}</div>` : ''}`;
  $('toast-stack').appendChild(el);
  const remove = () => { try { el.remove(); } catch {} };
  el.addEventListener('click', () => { remove(); onClick?.(); });
  if (ttl > 0) setTimeout(remove, ttl);
  return remove;
}

// ── Notify on needs-input transitions ────────────────────────────────────────
const _needsInputSeen = new Set();
function checkNeedsInputTransitions(prev, next) {
  const prevAttn = new Set(prev.filter(s => s.status === 'needs-input').map(s => s.id));
  for (const s of next) {
    if (s.status === 'needs-input' && !prevAttn.has(s.id) && !_needsInputSeen.has(s.id)) {
      _needsInputSeen.add(s.id);
      showToast({
        title: 'Needs your input',
        body: (getRenamedTitle(s.id) || s.aiTitle).slice(0, 80),
        kind: 'success',
        onClick: () => { switchTab('sessions'); openSession(s.id); },
      });
      // Try native notification when window is not focused
      if (typeof document !== 'undefined' && !document.hasFocus() && 'Notification' in window) {
        try {
          if (Notification.permission === 'granted') {
            new Notification('Claudemux — ' + (getRenamedTitle(s.id) || s.aiTitle), {
              body: 'claude is waiting on you.',
            });
          } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
          }
        } catch {}
      }
    }
    if (s.status !== 'needs-input') _needsInputSeen.delete(s.id);
  }
}
// Hook into loadSessions
const _origLoadSessions = loadSessions;
loadSessions = async function () {
  const before = allSessions.slice();
  await _origLoadSessions();
  checkNeedsInputTransitions(before, allSessions);
};

// ── Settings dialog ──────────────────────────────────────────────────────────
const SETTINGS_KEY = 'app-settings';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettingsObj(o) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch {}
}

function openSettings() {
  const s = loadSettings();
  $('settings-claude-bin').value      = s.claudeBin       || '';
  $('settings-sessions-visible').value = s.sessionsVisible || VISIBLE_RECENT;
  $('settings-term-font').value       = s.termFontSize    || 13;
  $('settings-refresh-ms').value      = s.refreshMs       || 5000;
  $('settings-modal').classList.remove('hidden');
}

$('settings-theme-dark').addEventListener('click',  () => applyTheme('dark'));
$('settings-theme-light').addEventListener('click', () => applyTheme('light'));
$('btn-settings-cancel').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
$('btn-settings-save').addEventListener('click', () => {
  const newSettings = {
    claudeBin:       $('settings-claude-bin').value.trim() || null,
    sessionsVisible: Math.max(1, Math.min(50, parseInt($('settings-sessions-visible').value, 10) || 5)),
    termFontSize:    Math.max(8, Math.min(24, parseInt($('settings-term-font').value, 10) || 13)),
    refreshMs:       Math.max(1000, Math.min(60000, parseInt($('settings-refresh-ms').value, 10) || 5000)),
  };
  saveSettingsObj(newSettings);
  // Apply terminal font size live to every open xterm
  for (const id in terminals) {
    try { terminals[id].options.fontSize = newSettings.termFontSize; } catch {}
    try { fitAddons[id]?.fit(); } catch {}
  }
  // Persist claude bin path on the main side
  if (newSettings.claudeBin) {
    window.api.setSetting?.({ key: 'claudeBin', value: newSettings.claudeBin });
  }
  $('settings-modal').classList.add('hidden');
  showToast({ title: 'Settings saved', kind: 'success' });
  renderSessionList(allSessions); // pick up sessionsVisible
});

// Wire the ⚙ toolbar button to open settings (Shift+click for quick theme toggle)
$('btn-settings').addEventListener('click', e => {
  if (e.shiftKey) toggleTheme(); else openSettings();
});

// ── JSONL message viewer ─────────────────────────────────────────────────────
async function openJsonlViewer(sessionId) {
  const session = sessionsMap.get(sessionId);
  if (!session) return;
  // Hide every other view + Sessions view
  for (const id of Object.values(TAB_TO_VIEW)) $(id).classList.add('hidden');
  $('view-grid')?.classList.add('hidden');
  $('view-jsonl').classList.remove('hidden');
  $('jsonl-title').textContent = getRenamedTitle(sessionId) || session.aiTitle;
  $('jsonl-subtitle').textContent = `${session.projectName} · ${sessionId}`;
  $('jsonl-wrap').innerHTML = '<div class="loading">Loading messages…</div>';

  const data = await window.api.readJsonl?.({ sessionId });
  if (!data) {
    $('jsonl-wrap').innerHTML = '<div class="empty">Could not load transcript.</div>';
    return;
  }
  $('jsonl-wrap').innerHTML = data.map(renderJsonlEntry).join('') || '<div class="empty">Empty transcript.</div>';
}

function renderJsonlEntry(entry) {
  if (entry.type === 'user' && entry.message) {
    const parts = jsonlExtractText(entry.message.content);
    return parts.map(text => `
      <div class="jsonl-msg user">
        <div class="jsonl-msg-head">
          <span class="jsonl-msg-role">User</span>
          <span>${esc(entry.timestamp || '')}</span>
        </div>
        <div class="jsonl-msg-body">${esc(text)}</div>
      </div>`).join('');
  }
  if (entry.type === 'assistant' && entry.message) {
    const content = entry.message.content;
    if (!Array.isArray(content)) return '';
    return content.map(part => {
      if (part.type === 'text') {
        return `
          <div class="jsonl-msg assistant">
            <div class="jsonl-msg-head">
              <span class="jsonl-msg-role">Assistant</span>
              <span>${esc(entry.timestamp || '')}</span>
            </div>
            <div class="jsonl-msg-body">${esc(part.text || '')}</div>
          </div>`;
      }
      if (part.type === 'tool_use') {
        const input = JSON.stringify(part.input || {}, null, 2);
        return `
          <div class="jsonl-msg tool-use">
            <div class="jsonl-msg-head">
              <span class="jsonl-msg-role">Tool · ${esc(part.name || '')}</span>
            </div>
            <div class="jsonl-msg-body">${esc(input)}</div>
          </div>`;
      }
      return '';
    }).join('');
  }
  if (entry.type === 'tool_result' || entry.toolUseResult) {
    const out = entry.toolUseResult || entry.content || '';
    return `
      <div class="jsonl-msg tool-result">
        <div class="jsonl-msg-head"><span class="jsonl-msg-role">Tool result</span></div>
        <div class="jsonl-msg-body">${esc(typeof out === 'string' ? out : JSON.stringify(out, null, 2))}</div>
      </div>`;
  }
  return '';
}

function jsonlExtractText(content) {
  if (!content) return [];
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').filter(Boolean);
  }
  return [];
}

$('btn-jsonl-back').addEventListener('click', () => {
  $('view-jsonl').classList.add('hidden');
  switchTab(currentTab);
});

// ── Sidebar resize ───────────────────────────────────────────────────────────
(() => {
  const sidebar = document.querySelector('.sidebar');
  const handle  = $('sidebar-resize');
  const SIDEBAR_W_KEY = 'sidebar-width';
  try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || '0', 10);
    if (saved >= 200 && saved <= 520) sidebar.style.width = saved + 'px';
  } catch {}

  let sbDrag = false, sbStartX = 0, sbStartW = 0;
  handle.addEventListener('mousedown', e => {
    sbDrag = true;
    sbStartX = e.clientX;
    sbStartW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!sbDrag) return;
    const w = Math.max(200, Math.min(520, sbStartW + (e.clientX - sbStartX)));
    sidebar.style.width = w + 'px';
    if (activeSession) {
      const fa = fitAddons[activeSession.id];
      if (fa) try { fa.fit(); } catch {}
    }
  });
  document.addEventListener('mouseup', () => {
    if (!sbDrag) return;
    sbDrag = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem(SIDEBAR_W_KEY, String(sidebar.offsetWidth)); } catch {}
  });
})();

// ── Saved scroll positions ───────────────────────────────────────────────────
const SCROLL_KEY = 'scroll-positions';
function saveScrollPositions() {
  const positions = {
    sessions: $('session-list')?.scrollTop ?? 0,
    plans:    $('plan-list')?.scrollTop    ?? 0,
    memory:   $('memory-list')?.scrollTop  ?? 0,
  };
  try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(positions)); } catch {}
}
function restoreScrollPositions() {
  try {
    const p = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
    if ($('session-list') && p.sessions) $('session-list').scrollTop = p.sessions;
    if ($('plan-list')    && p.plans)    $('plan-list').scrollTop    = p.plans;
    if ($('memory-list')  && p.memory)   $('memory-list').scrollTop  = p.memory;
  } catch {}
}
for (const id of ['session-list','plan-list','memory-list']) {
  const el = $(id);
  if (el) el.addEventListener('scroll', () => saveScrollPositions());
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const TAB_KEY_MAP = { '1': 'sessions', '2': 'plans', '3': 'stats', '4': 'memory' };

function getVisibleSessionItems() {
  return [...document.querySelectorAll('#session-list .session-item')];
}

function navigateSession(direction) {
  const items = getVisibleSessionItems();
  if (!items.length) return;
  const activeIdx = items.findIndex(it => it.dataset.id === activeSession?.id);
  let nextIdx = activeIdx;
  if (direction > 0) nextIdx = activeIdx < 0 ? 0 : Math.min(items.length - 1, activeIdx + 1);
  else               nextIdx = activeIdx < 0 ? items.length - 1 : Math.max(0, activeIdx - 1);
  const target = items[nextIdx];
  if (target) {
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    openSession(target.dataset.id);
  }
}

document.addEventListener('keydown', e => {
  const inEditableField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;

  // Esc — close any open modal/menu first
  if (e.key === 'Escape') {
    $('new-session-modal')?.classList.add('hidden');
    $('settings-modal')?.classList.add('hidden');
    hideContextMenu?.();
    return;
  }

  if (inEditableField) return;

  // Ctrl/Cmd + 1..4 — switch tabs
  if ((e.ctrlKey || e.metaKey) && TAB_KEY_MAP[e.key]) {
    e.preventDefault();
    switchTab(TAB_KEY_MAP[e.key]);
    return;
  }
  // Ctrl/Cmd + N — new session
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    $('btn-new-session')?.click();
    return;
  }
  // Ctrl/Cmd + R — refresh
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    loadSessions();
    return;
  }
  // Ctrl/Cmd + , — settings
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    openSettings?.();
    return;
  }
  // ArrowUp/Down — navigate sessions (only in Sessions tab)
  if (currentTab === 'sessions' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    navigateSession(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
});

// ── Auto-refresh ─────────────────────────────────────────────────────────────
let refreshTimer = null;
function scheduleAutoRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const settings = (() => { try { return JSON.parse(localStorage.getItem('app-settings') || '{}'); } catch { return {}; } })();
  const fast = settings.refreshMs || 5000;
  const interval = runningSet.size > 0 ? fast : 30000;
  refreshTimer = setTimeout(async () => {
    await loadSessions();
    scheduleAutoRefresh();
  }, interval);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadSessions().then(() => {
  restoreScrollPositions();
  scheduleAutoRefresh();
});
