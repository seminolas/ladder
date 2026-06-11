// Encrypts a GitHub PAT with a password using AES-GCM + PBKDF2.
// Usage: node scripts/encrypt-pat.js <password>
// Reads GH_PAT from .env and outputs the encrypted blob for config.json.

require('dotenv').config();

const pat      = process.env.GH_PAT;
const password = process.argv[2];

if (!pat)      { console.error('GH_PAT not found in .env'); process.exit(1); }
if (!password) { console.error('Usage: node scripts/encrypt-pat.js <password>'); process.exit(1); }

async function encryptPAT(pat, password) {
  const enc  = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv   = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const km   = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(pat));
  return Buffer.from(JSON.stringify({
    salt: Array.from(salt),
    iv:   Array.from(iv),
    ct:   Array.from(new Uint8Array(ct)),
  })).toString('base64');
}

encryptPAT(pat, password).then(blob => {
  console.log(blob);
});
