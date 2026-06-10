// GitHub API storage layer.
// Reads leaderboard and sessions from a GitHub repo.
// Writes require a Personal Access Token stored in localStorage.
// The target branch is read from config.json served alongside the app —
// injected at deploy time so main and staging automatically target their own branch.

const Storage = (() => {
  const CONFIG_KEY = 'badminton_gh_config';

  // Branch is resolved once from config.json and cached
  let _branch = null;

  async function getBranch() {
    if (_branch) return _branch;
    try {
      const res = await fetch('config.json');
      if (res.ok) {
        const cfg = await res.json();
        _branch = cfg.branch || 'main';
        return _branch;
      }
    } catch {}
    _branch = 'main';
    return _branch;
  }

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    } catch { return {}; }
  }

  function saveConfig(cfg) {
    // Never persist branch — it comes from config.json
    const { branch: _ignored, ...rest } = cfg;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(rest));
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.owner && c.repo && c.pat);
  }

  function headers(pat) {
    return {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async function readFile(path) {
    const { owner, repo, pat } = getConfig();
    if (!owner || !repo) throw new Error('GitHub not configured');
    const branch = await getBranch();

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const h = pat ? headers(pat) : { 'Accept': 'application/vnd.github.v3+json' };
    const res = await fetch(url, { headers: h });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);

    const data = await res.json();
    const content = atob(data.content.replace(/\n/g, ''));
    return { content: JSON.parse(content), sha: data.sha };
  }

  async function writeFile(path, content, sha) {
    const { owner, repo, pat } = getConfig();
    if (!pat) throw new Error('No PAT configured — cannot write');
    const branch = await getBranch();

    const body = {
      message: `Update ${path}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
      branch,
    };
    if (sha) body.sha = sha;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, { method: 'PUT', headers: headers(pat), body: JSON.stringify(body) });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub write failed: ${res.status}`);
    }
    const data = await res.json();
    return data.content.sha;
  }

  async function listSessions() {
    const files = await listSessionFiles();
    return files.map(f => f.date);
  }

  async function listSessionFiles() {
    const { owner, repo, pat } = getConfig();
    if (!owner || !repo) return [];
    const branch = await getBranch();

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/sessions?ref=${branch}`;
    const h = pat ? headers(pat) : { 'Accept': 'application/vnd.github.v3+json' };
    const res = await fetch(url, { headers: h });

    if (res.status === 404) return [];
    if (!res.ok) return [];

    const files = await res.json();
    return files
      .filter(f => f.name.endsWith('.json'))
      .map(f => ({ date: f.name.replace('.json', ''), path: f.path, sha: f.sha }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async function deleteFile(path, sha) {
    const { owner, repo, pat } = getConfig();
    if (!pat) throw new Error('No PAT configured — cannot delete');
    const branch = await getBranch();

    const body = { message: `Delete ${path}`, sha, branch };
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, { method: 'DELETE', headers: headers(pat), body: JSON.stringify(body) });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub delete failed: ${res.status}`);
    }
  }

  async function getLeaderboard() {
    return readFile('data/leaderboard.json');
  }

  async function saveLeaderboard(players, sha) {
    const content = { players, updatedAt: new Date().toISOString().split('T')[0] };
    return writeFile('data/leaderboard.json', content, sha);
  }

  async function getSession(date) {
    return readFile(`data/sessions/${date}.json`);
  }

  async function saveSession(date, sessionData, sha) {
    return writeFile(`data/sessions/${date}.json`, sessionData, sha);
  }

  return { getConfig, saveConfig, isConfigured, getBranch, getLeaderboard, saveLeaderboard, getSession, saveSession, listSessions, listSessionFiles, deleteFile };
})();
