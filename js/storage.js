// GitHub API storage layer.
// Owner and repo are hardcoded — this app serves one club.
// The target branch is read from config.json served alongside the app.
// Admin writes require a PAT, which is stored encrypted in config.json
// and decrypted in-memory after the user provides the admin password.

const Storage = (() => {
  const OWNER = 'seminolas';
  const REPO  = 'ladder';
  const ADMIN_PASSWORD_KEY = 'badminton_admin_password';

  let _branch = null;
  let _encryptedPAT = null;
  let _pat = null;         // decrypted PAT held in memory only
  let _hcKey = null;       // decrypted HelloClub API key held in memory only

  // ── Remote config (config.json) ──────────────────────────────────────────

  async function getRemoteConfig() {
    try {
      const res = await fetch('config.json');
      if (res.ok) return await res.json();
    } catch {}
    return {};
  }

  async function getBranch() {
    if (_branch) return _branch;
    const cfg = await getRemoteConfig();
    _branch = cfg.branch || 'main';
    return _branch;
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  async function decryptPAT(encryptedBlob, password) {
    const { salt, iv, ct } = JSON.parse(atob(encryptedBlob));
    const enc = new TextEncoder();
    const km  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100_000, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(ct));
    return new TextDecoder().decode(plain);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  // Called once on app init. Silently restores admin session from saved password.
  async function autoLogin() {
    const password = localStorage.getItem(ADMIN_PASSWORD_KEY);
    if (!password) return false;
    try {
      const cfg = await getRemoteConfig();
      if (!cfg.encryptedPAT) return false;
      _encryptedPAT = cfg.encryptedPAT;
      _pat = await decryptPAT(_encryptedPAT, password);
      if (cfg.encryptedHCKey) _hcKey = await decryptPAT(cfg.encryptedHCKey, password);
      return true;
    } catch {
      // Saved password no longer works (PAT rotated) — clear it
      localStorage.removeItem(ADMIN_PASSWORD_KEY);
      return false;
    }
  }

  // Called when user submits the login form. Throws on wrong password.
  async function login(password) {
    const cfg = await getRemoteConfig();
    if (!cfg.encryptedPAT) throw new Error('No encrypted PAT found in config.json');
    _encryptedPAT = cfg.encryptedPAT;
    _pat = await decryptPAT(_encryptedPAT, password);
    if (cfg.encryptedHCKey) _hcKey = await decryptPAT(cfg.encryptedHCKey, password);
    localStorage.setItem(ADMIN_PASSWORD_KEY, password);
  }

  function logout() {
    _pat = null;
    _hcKey = null;
    localStorage.removeItem(ADMIN_PASSWORD_KEY);
  }

  function getHCKey() { return _hcKey; }

  function isAdmin() {
    return !!_pat;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  function authHeaders() {
    return {
      'Authorization': `token ${_pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  function readHeaders() {
    return { 'Accept': 'application/vnd.github.v3+json' };
  }

  // ── File operations ───────────────────────────────────────────────────────

  async function readFile(path) {
    const branch = await getBranch();
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${branch}`;
    // Public repo — always read unauthenticated; avoids 403s if the PAT lacks read scope
    const res  = await fetch(url, { headers: readHeaders() });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);

    const data    = await res.json();
    const raw     = atob(data.content.replace(/\n/g, ''));
    const content = JSON.parse(decodeURIComponent(escape(raw)));
    return { content, sha: data.sha };
  }

  async function writeFile(path, content, sha) {
    if (!_pat) throw new Error('Admin login required');
    const branch = await getBranch();

    const body = {
      message: `Update ${path}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
      branch,
    };
    if (sha) body.sha = sha;

    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
    const res = await fetch(url, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub write failed: ${res.status}`);
    }
    const data = await res.json();
    return data.content.sha;
  }

  async function deleteFile(path, sha) {
    if (!_pat) throw new Error('Admin login required');
    const branch = await getBranch();

    const body = { message: `Delete ${path}`, sha, branch };
    const url  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
    const res  = await fetch(url, { method: 'DELETE', headers: authHeaders(), body: JSON.stringify(body) });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub delete failed: ${res.status}`);
    }
  }

  // ── Session / leaderboard ─────────────────────────────────────────────────

  async function listSessions() {
    const files = await listSessionFiles();
    return files.map(f => f.date);
  }

  async function listSessionFiles() {
    const branch = await getBranch();
    const url    = `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/sessions?ref=${branch}`;
    // Public repo — always read unauthenticated
    const res    = await fetch(url, { headers: readHeaders() });

    if (res.status === 404) return [];
    if (!res.ok) return [];

    const files = await res.json();
    return files
      .filter(f => f.name.endsWith('.json'))
      .map(f => ({ date: f.name.replace('.json', ''), path: f.path, sha: f.sha }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async function getHCMembers() {
    const res = await fetch('data/helloclub-members.json');
    if (!res.ok) throw new Error('HelloClub member mapping not found');
    return res.json();
  }

  async function getLeaderboard()             { return readFile('data/leaderboard.json'); }
  async function saveLeaderboard(players, sha) {
    const content = { players, updatedAt: new Date().toISOString().split('T')[0] };
    return writeFile('data/leaderboard.json', content, sha);
  }
  async function getSession(date)                    { return readFile(`data/sessions/${date}.json`); }
  async function saveSession(date, sessionData, sha) { return writeFile(`data/sessions/${date}.json`, sessionData, sha); }

  return {
    getBranch, autoLogin, login, logout, isAdmin, getHCKey,
    getLeaderboard, saveLeaderboard,
    getSession, saveSession,
    listSessions, listSessionFiles, deleteFile,
    getHCMembers,
  };
})();
