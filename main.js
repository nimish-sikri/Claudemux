'use strict';

const { app, BrowserWindow, ipcMain, shell, nativeTheme, clipboard } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

nativeTheme.themeSource = 'dark';

// ── Constants ─────────────────────────────────────────────────────────────────
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN || 'claude';

// ── Active PTY sessions ───────────────────────────────────────────────────────
const activeSessions = new Map();   // sessionId -> { pty, cwd }
let mainWindow = null;

// ── Session scanning ──────────────────────────────────────────────────────────
function decodePath(encodedName) {
  // Claude encodes  C:\Users\foo  →  C--Users-foo
  if (/^[A-Za-z]--/.test(encodedName)) {
    const drive = encodedName[0];
    const rest  = encodedName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }
  // Unix:  /home/user/foo  →  -home-user-foo
  return '/' + encodedName.replace(/-/g, '/').replace(/^\//, '');
}

function relTime(isoStr) {
  if (!isoStr) return '';
  try {
    const dt  = new Date(isoStr);
    const s   = Math.floor((Date.now() - dt) / 1000);
    if (s < 60)       return `${s}s ago`;
    if (s < 3600)     return `${Math.floor(s/60)}m ago`;
    if (s < 86400)    return `${Math.floor(s/3600)}h ago`;
    if (s < 604800)   return `${Math.floor(s/86400)}d ago`;
    return dt.toLocaleDateString();
  } catch { return ''; }
}

function extractRenameTarget(content) {
  // /rename <new title> — strip quotes if present
  if (typeof content !== 'string') return null;
  const m = content.match(/^\/rename\s+(.+?)\s*$/);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function parseSession(jsonlPath, projectDir) {
  let aiTitle = null, cwd = null, firstMsg = '', lastTs = null;
  let userTurns = 0, assistantTurns = 0;
  let renamedTitle = null;
  let lastEntryType = null, lastStopReason = null;
  let toolUsePending = false;

  try {
    const size = fs.statSync(jsonlPath).size;
    if (size === 0) return null;

    const fd   = fs.openSync(jsonlPath, 'r');
    const head = Buffer.alloc(Math.min(size, 32768));
    fs.readSync(fd, head, 0, head.length, 0);

    const tailSize = Math.min(size, 16384);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    fs.closeSync(fd);

    // ── Head: collect title, cwd, first user message, turn counts ─────────────
    const headLines = head.toString('utf8').split('\n').slice(0, 200);
    for (const line of headLines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === 'ai-title' && !aiTitle) aiTitle = entry.aiTitle?.trim();
      if (entry.cwd && !cwd) cwd = entry.cwd;
      if (entry.timestamp) lastTs = entry.timestamp;
      if (entry.type === 'user')      userTurns++;
      if (entry.type === 'assistant') assistantTurns++;

      // /rename slash command in queue-operation or user content
      const renameCmd =
        extractRenameTarget(entry.content) ||
        extractRenameTarget(entry.message?.content) ||
        (Array.isArray(entry.message?.content)
          ? entry.message.content.find(c => c.type === 'text' && extractRenameTarget(c.text)) &&
            extractRenameTarget(entry.message.content.find(c => c.type === 'text').text)
          : null);
      if (renameCmd) renamedTitle = renameCmd;

      if (!firstMsg && entry.type === 'user' && !entry.isMeta) {
        const content = entry.message?.content || '';
        if (typeof content === 'string' && !content.startsWith('<') && !content.startsWith('/')) {
          firstMsg = content.slice(0, 120).trim();
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && !item.text?.startsWith('<') && !item.text?.startsWith('/')) {
              firstMsg = item.text.slice(0, 120).trim();
              break;
            }
          }
        }
      }
    }

    // ── Tail: latest ai-title, latest /rename, and last entry status ──────────
    const tailLines = tail.toString('utf8').split('\n').filter(l => l.trim());
    for (const line of tailLines) {
      try {
        const e = JSON.parse(line);
        if (e.timestamp) lastTs = e.timestamp;
        if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle.trim();
        const r =
          extractRenameTarget(e.content) ||
          extractRenameTarget(e.message?.content);
        if (r) renamedTitle = r;
      } catch {}
    }
    // Walk back from the very last line to determine current state
    for (let i = tailLines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(tailLines[i]);
        if (e.type === 'user' || e.type === 'assistant') {
          lastEntryType = e.type;
          lastStopReason = e.message?.stop_reason || null;
          if (Array.isArray(e.message?.content)) {
            toolUsePending = e.message.content.some(c => c.type === 'tool_use');
          }
          break;
        }
      } catch {}
    }
  } catch { return null; }

  // ── Derive status from last entry ────────────────────────────────────────
  // 'running' is applied later in getAllSessions if a PTY is active.
  let status = 'idle';
  const ageMs = lastTs ? Date.now() - new Date(lastTs).getTime() : Infinity;
  const isRecent = ageMs < 24 * 3600 * 1000; // 24h
  if (lastEntryType === 'assistant') {
    if (toolUsePending || lastStopReason === 'tool_use') status = isRecent ? 'busy'        : 'idle';
    else                                                  status = isRecent ? 'needs-input' : 'idle';
  } else if (lastEntryType === 'user') {
    status = isRecent ? 'busy' : 'idle';
  }

  const sessionId = path.basename(jsonlPath, '.jsonl');
  const projectPath = decodePath(path.basename(projectDir));
  const projectName = projectPath.split(/[/\\]/).filter(Boolean).pop() || path.basename(projectDir);

  return {
    id:             sessionId,
    projectName,
    projectPath,
    projectDir:     path.basename(projectDir),
    cwd:            cwd || projectPath,
    aiTitle:        renamedTitle || aiTitle || firstMsg.slice(0, 60) || 'Untitled Session',
    preview:        firstMsg,
    renamed:        !!renamedTitle,
    userTurns,
    assistantTurns,
    lastTs,
    rel:            relTime(lastTs),
    status,
  };
}

function getAllSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const sessions = [];

  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projPath = path.join(CLAUDE_PROJECTS, projectDir.name);

    for (const file of fs.readdirSync(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const s = parseSession(path.join(projPath, file), projPath);
      if (s) {
        // Active PTY trumps derived status
        if (activeSessions.has(s.id)) s.status = 'running';
        sessions.push(s);
      }
    }
  }

  sessions.sort((a, b) => (b.lastTs || '') < (a.lastTs || '') ? -1 : 1);
  return sessions;
}

// ── PTY management ────────────────────────────────────────────────────────────
function resolveClaudeBin() {
  // Try explicit env override first
  if (process.env.CLAUDE_CODE_BIN && fs.existsSync(process.env.CLAUDE_CODE_BIN)) {
    return process.env.CLAUDE_CODE_BIN;
  }
  // Common install locations on Windows
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
    'claude',
  ];
  for (const c of candidates) {
    if (c === 'claude') return c; // let the shell resolve it
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

function spawnSession(sessionId, cwd, resumeFlag) {
  if (activeSessions.has(sessionId)) return false;

  const claudeExe = resolveClaudeBin();
  // Augment PATH so the shell can find claude even if Electron launched without user PATH
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
  ].join(path.delimiter);
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: extraPaths + path.delimiter + (process.env.PATH || ''),
  };

  const workDir = fs.existsSync(cwd) ? cwd : os.homedir();
  const ptyArgs = resumeFlag ? ['--resume', sessionId] : [];

  let pty;
  try {
    const nodePty = require('node-pty');

    if (process.platform === 'win32') {
      // On Windows spawn claude directly — avoids cmd.exe /c which exits immediately
      // For .cmd files, route through cmd.exe /k to keep the shell alive
      if (claudeExe.endsWith('.cmd')) {
        pty = nodePty.spawn('cmd.exe', ['/k', claudeExe, ...ptyArgs], {
          name: 'xterm-256color', cols: 120, rows: 40, cwd: workDir, env,
        });
      } else {
        pty = nodePty.spawn(claudeExe, ptyArgs, {
          name: 'xterm-256color', cols: 120, rows: 40, cwd: workDir, env,
        });
      }
    } else {
      pty = nodePty.spawn(claudeExe, ptyArgs, {
        name: 'xterm-256color', cols: 120, rows: 40, cwd: workDir, env,
      });
    }
  } catch (e) {
    console.warn('node-pty unavailable, using pipe mode:', e.message);
    const { spawn } = require('child_process');
    pty = spawn(claudeExe, ptyArgs, {
      cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    pty.write = (data) => pty.stdin.write(data);
    pty.resize = () => {};
    pty.stdout.on('data', d => pty.emit('data', d.toString()));
    pty.stderr.on('data', d => pty.emit('data', d.toString()));
    pty.on('close', (code) => pty.emit('exit', code));
  }

  pty.on('data', (data) => {
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('pty-data', { sessionId, data: data.toString ? data.toString() : data });
    }
  });

  pty.on('exit', (code) => {
    activeSessions.delete(sessionId);
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('session-exited', { sessionId, code });
    }
  });

  activeSessions.set(sessionId, { pty, cwd });
  return true;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-sessions', () => getAllSessions());

ipcMain.handle('launch-session', (_, { sessionId, cwd, resume }) => {
  return spawnSession(sessionId, cwd, resume);
});

ipcMain.handle('send-input', (_, { sessionId, data }) => {
  const s = activeSessions.get(sessionId);
  if (s) { s.pty.write(data); return true; }
  return false;
});

ipcMain.handle('resize-pty', (_, { sessionId, cols, rows }) => {
  const s = activeSessions.get(sessionId);
  if (s?.pty?.resize) s.pty.resize(cols, rows);
});

ipcMain.handle('kill-session', (_, { sessionId }) => {
  const s = activeSessions.get(sessionId);
  if (s) {
    try { s.pty.kill(); } catch {}
    activeSessions.delete(sessionId);
    return true;
  }
  return false;
});

ipcMain.handle('read-file', (_, { filePath }) => {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
});

ipcMain.handle('open-external', (_, { url }) => shell.openExternal(url));

// Electron's clipboard module never fails on CSP / focus / user-gesture rules
// like navigator.clipboard does, so we route copy/paste through main.
ipcMain.handle('clipboard-read',  ()         => clipboard.readText());
ipcMain.handle('clipboard-write', (_, text)  => { clipboard.writeText(String(text || '')); return true; });

ipcMain.handle('reveal-in-explorer', (_, { path: p }) => {
  try { shell.openPath(p); return true; } catch { return false; }
});

ipcMain.handle('delete-session', (_, { sessionId }) => {
  // Find the JSONL file matching this sessionId across all project dirs
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const candidate = path.join(CLAUDE_PROJECTS, dir, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) {
        // Kill PTY first if running
        const active = activeSessions.get(sessionId);
        if (active) { try { active.pty.kill(); } catch {} activeSessions.delete(sessionId); }
        fs.unlinkSync(candidate);
        return true;
      }
    }
  } catch (e) { console.warn('delete-session failed', e); }
  return false;
});

ipcMain.handle('read-jsonl', (_, { sessionId }) => {
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const candidate = path.join(CLAUDE_PROJECTS, dir, sessionId + '.jsonl');
      if (!fs.existsSync(candidate)) continue;
      const lines = fs.readFileSync(candidate, 'utf8').split('\n').filter(l => l.trim());
      const out = [];
      for (const l of lines) {
        try { out.push(JSON.parse(l)); } catch {}
      }
      return out;
    }
  } catch (e) { console.warn('read-jsonl failed', e); }
  return null;
});

ipcMain.handle('set-title-bar-overlay', (_, opts) => {
  if (process.platform !== 'win32' || !mainWindow) return false;
  try {
    mainWindow.setTitleBarOverlay({
      color:       opts.color       || '#131316',
      symbolColor: opts.symbolColor || '#93939a',
      height:      30,
    });
    mainWindow.setBackgroundColor(opts.color || '#131316');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('get-setting', (_, { key }) => {
  try { return require('./db').getSetting(key); } catch { return null; }
});

ipcMain.handle('set-setting', (_, { key, value }) => {
  try { require('./db').setSetting(key, value); } catch {}
});

// ── Plans / Memory / Stats helpers ────────────────────────────────────────────
function safeReadText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}
function safeWriteText(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) { console.warn('write failed', filePath, e.message); return false; }
}

function listProjects() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const out = [];
  for (const name of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const projPath = decodePath(name.name);
    out.push({
      encoded: name.name,
      path:    projPath,
      name:    projPath.split(/[/\\]/).filter(Boolean).pop() || name.name,
      exists:  fs.existsSync(projPath),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listPlans() {
  // Aggregate .claude/plans/*.md across every known project + the global ~/.claude/plans
  const out = [];
  const seen = new Set();
  const scanDir = (dir, projectName) => {
    if (!fs.existsSync(dir)) return;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(md|markdown|txt)$/i.test(f)) continue;
        const p = path.join(dir, f);
        if (seen.has(p)) continue;
        seen.add(p);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        out.push({
          name: f,
          path: p,
          size: st.size,
          mtime: st.mtime.toISOString(),
          projectName,
        });
      }
    } catch {}
  };
  // Global plans
  scanDir(path.join(os.homedir(), '.claude', 'plans'), '(global)');
  // Per-project plans
  for (const proj of listProjects()) {
    scanDir(path.join(proj.path, '.claude', 'plans'), proj.name);
  }
  return out.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
}

function listMemoryFiles() {
  const out = [];
  const push = (name, p, scope) => {
    out.push({ name, path: p, scope, exists: fs.existsSync(p) });
  };
  push('~/.claude/CLAUDE.md (global)', path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'global');
  for (const proj of listProjects()) {
    const p = path.join(proj.path, 'CLAUDE.md');
    if (fs.existsSync(p)) push(`${proj.name}/CLAUDE.md`, p, 'project');
  }
  return out;
}

function getStats() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    return { perDay: {}, perProject: {}, totalSessions: 0, totalProjects: 0, totalMessages: 0 };
  }
  const perDay = {};
  const perProject = {};
  let totalSessions = 0;
  let totalMessages = 0;
  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projPath = path.join(CLAUDE_PROJECTS, projectDir.name);
    const projName = decodePath(projectDir.name).split(/[/\\]/).filter(Boolean).pop() || projectDir.name;
    perProject[projName] = perProject[projName] || 0;
    for (const f of fs.readdirSync(projPath)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(projPath, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      const day = st.mtime.toISOString().slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
      perProject[projName] += 1;
      totalSessions += 1;
      // Estimate messages = size / 1500 bytes (rough)
      totalMessages += Math.max(1, Math.round(st.size / 1500));
    }
  }
  return {
    perDay,
    perProject,
    totalSessions,
    totalProjects: Object.values(perProject).filter(v => v > 0).length,
    totalMessages,
  };
}

// ── Plans IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('list-plans',   () => listPlans());
ipcMain.handle('read-plan',    (_, { filePath })          => safeReadText(filePath));
ipcMain.handle('write-plan',   (_, { filePath, content }) => safeWriteText(filePath, content));
ipcMain.handle('new-plan',     (_, { projectPath, name }) => {
  const base = projectPath || os.homedir() + '/.claude';
  const dir  = path.join(base, '.claude', 'plans');
  const safe = name.replace(/[<>:"/\\|?*]/g, '_');
  const p    = path.join(dir, safe.endsWith('.md') ? safe : safe + '.md');
  if (fs.existsSync(p)) return { ok: false, error: 'exists', path: p };
  if (safeWriteText(p, `# ${safe.replace(/\.md$/,'')}\n\n`)) return { ok: true, path: p };
  return { ok: false, error: 'write_failed' };
});
ipcMain.handle('delete-plan',  (_, { filePath }) => {
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
});

// ── Memory IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('list-memory',  () => listMemoryFiles());
ipcMain.handle('read-memory',  (_, { filePath })          => safeReadText(filePath));
ipcMain.handle('write-memory', (_, { filePath, content }) => safeWriteText(filePath, content));

// ── Stats / Projects IPC ─────────────────────────────────────────────────────
ipcMain.handle('list-projects', () => listProjects());
ipcMain.handle('get-stats',     () => getStats());

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:          1400,
    height:         900,
    minWidth:       800,
    minHeight:      500,
    title:          'Claudemux',
    backgroundColor:'#0e0e10',
    icon:           path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
    },
    // Overlay-style window controls on Windows = no chunky native title bar
    titleBarStyle:        process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? {
      color:       '#131316',
      symbolColor: '#93939a',
      height:      30,
    } : undefined,
    frame: process.platform !== 'win32',
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  if (process.env.DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    // Kill all active sessions
    for (const [, s] of activeSessions) {
      try { s.pty.kill(); } catch {}
    }
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
