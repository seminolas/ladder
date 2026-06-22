# Badminton Club Ladder

Static SPA deployed to GitHub Pages. Uses the GitHub API as a database (JSON files in this repo).

## Admin access

A shared password unlocks admin features (create sessions, edit scores, import leaderboard). The password decrypts a GitHub PAT stored encrypted in `config.json`. Non-admins can view the leaderboard and past sessions.

Share the password with committee members verbally or via a secure channel. They enter it once per device via the "Admin Login" button and stay logged in.

## Rotating the PAT

When the PAT expires or needs replacing:

1. Generate a new fine-grained PAT on GitHub with **Contents: read + write** on this repo only.
2. Add it to `.env` temporarily:
   ```
   GH_PAT=github_pat_...new...
   GH_ADMIN_PASSWORD=your-current-password
   ```
3. Re-encrypt:
   ```
   node scripts/encrypt-pat.js your-current-password
   ```
4. Copy the output into `config.json` as `"encryptedPAT"`.
5. Remove `GH_PAT` from `.env` (keep only `GH_ADMIN_PASSWORD`).
6. Commit and push `config.json`.

Members' saved passwords continue to work — no action needed on their devices.

## Changing the password

Run step 3 above with the new password instead. Update `GH_ADMIN_PASSWORD` in `.env`. Tell members the new password; they re-enter it once.

## Generating the blob manually (browser console or `node` REPL)

```js
async function encryptPAT(pat, password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(pat));
  return btoa(JSON.stringify({ salt: [...salt], iv: [...iv], ct: [...new Uint8Array(ct)] }));
}
encryptPAT('github_pat_...', 'your-password').then(console.log);
```

Paste the output into `config.json` as `"encryptedPAT"`, then commit and push.

## Staging vs main — data separation

The app is deployed from two branches. Both deployments share the same codebase
but write data to different branches:

| Deployment | URL path | Reads/writes data to |
|---|---|---|
| Production | `/` | `main` branch |
| Staging | `/staging/` | `staging` branch |

This is handled by the GitHub Actions deploy workflow (`deploy.yml`), which
injects the correct `"branch"` value into each deployment's `config.json` at
build time. The `config.json` committed to the repo is irrelevant at runtime.

### Merging staging → main without bringing data across

Session and leaderboard JSON files live under `data/`. These should never be
merged from staging into main (or vice versa) — each branch's data is
independent.

`.gitattributes` marks `data/**` with a custom `ours` merge driver that silently
keeps the current branch's version of any data file during a merge. This means
a plain `git merge staging` on `main` will bring in code changes and ignore all
`data/` changes automatically.

**One-time setup required on each machine that does merges:**

```bash
git config merge.ours.driver true
```

This registers the `ours` driver (a no-op that exits 0, telling git to keep the
working-tree file untouched). Without this step the attribute is ignored and
data file conflicts will surface manually as before.

## Running tests

```
npm test              # unit tests
npm run test:e2e      # Playwright E2E (requires .env with GH_ADMIN_PASSWORD)
```
