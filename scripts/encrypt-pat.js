// Encrypts secrets with a password using AES-GCM + PBKDF2.
// Usage: node scripts/encrypt-pat.js <password>
// Reads GH_PAT and HC_API_KEY from .env and outputs encrypted blobs for config.json.

require('dotenv').config();

const pat     = process.env.GH_PAT;
const hcKey   = process.env.HC_API_KEY;
const password = process.argv[2];

if (!password) { console.error('Usage: node scripts/encrypt-pat.js <password>'); process.exit(1); }
if (!pat && !hcKey) { console.error('No GH_PAT or HC_API_KEY found in .env'); process.exit(1); }

async function encrypt(secret, password) {
  const enc  = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv   = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const km   = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret));
  return Buffer.from(JSON.stringify({
    salt: Array.from(salt),
    iv:   Array.from(iv),
    ct:   Array.from(new Uint8Array(ct)),
  })).toString('base64');
}

(async () => {
  if (pat) {
    const blob = await encrypt(pat, password);
    console.log(`encryptedPAT: "${blob}"`);
  }
  if (hcKey) {
    const blob = await encrypt(hcKey, password);
    console.log(`encryptedHCKey: "${blob}"`);
  }
})();
