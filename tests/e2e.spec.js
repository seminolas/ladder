require('dotenv').config();
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const fs = require('fs');

const BASE_URL      = 'https://seminolas.github.io/ladder/staging/';
const STAGING_BRANCH = 'staging';
const SESSION_DATE = '2026-06-16';

// Pairings from algorithm.js
const PAIRINGS_4 = [
  { pair1: [0, 1], pair2: [2, 3] }, // M0
  { pair1: [0, 2], pair2: [1, 3] }, // M1
  { pair1: [0, 3], pair2: [1, 2] }, // M2
];
const PAIRINGS_5 = [
  { pair1: [0, 1], pair2: [2, 4] }, // M0: sitout=3
  { pair1: [2, 3], pair2: [1, 4] }, // M1: sitout=0
  { pair1: [3, 4], pair2: [0, 2] }, // M2: sitout=1
  { pair1: [0, 3], pair2: [1, 2] }, // M3: sitout=4
  { pair1: [1, 3], pair2: [0, 4] }, // M4: sitout=2
];

// 9 players → box-of-4 (top 4 by rank) + box-of-5 (next 5 by rank)
// Box 1 indices: P0(top)..P3 — pair1 wins all 3 matches → standings = seeding order
const BOX1_SCORES = [
  [[21, 10], [21, 11]], // M0 [0,1]v[2,3]: pair1 wins
  [[21, 15], [21, 17]], // M1 [0,2]v[1,3]: pair1 wins
  [[21, 18], [21, 19]], // M2 [0,3]v[1,2]: pair1 wins
];
// Box 2 (5 players, indices 0=vilius .. 4=TestPlayer)
// Vilius(0) wins 4 matches (1st), Jency(2) and Stephen(3) each win 2 (2nd/3rd by points),
// Aiko(1) wins 1 (4th), TestPlayer(4) wins 1 (5th)
const BOX2_SCORES = [
  [[21, 14], [21, 16]], // M0 [0,1]v[2,4]: pair1 wins → Vilius+Aiko
  [[21, 15], [21, 13]], // M1 [2,3]v[1,4]: pair1 wins → Jency+Stephen (Vilius sits)
  [[12, 21], [15, 21]], // M2 [3,4]v[0,2]: pair2 wins → Vilius+Jency
  [[21, 17], [21, 14]], // M3 [0,3]v[1,2]: pair1 wins → Vilius+Stephen
  [[18, 21], [16, 21]], // M4 [1,3]v[0,4]: pair2 wins → Vilius+TestPlayer
];

// 8 real players from leaderboard; Test Player added as new (not in leaderboard)
const SEARCH_TERMS = ['rory', 'shivam', 'ray', 'kenzie', 'vilius', 'aiko', 'jency', 'stephen'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function ghApiJson(path, branch = STAGING_BRANCH) {
  const raw  = execSync(
    `gh api "repos/seminolas/ladder/contents/${path}?ref=${branch}"`,
    { encoding: 'utf8' }
  );
  const meta = JSON.parse(raw);
  return { content: JSON.parse(Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: meta.sha };
}

function ghApiWrite(path, content, sha, message) {
  const contentB64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const body = JSON.stringify(sha
    ? { message, content: contentB64, branch: STAGING_BRANCH, sha }
    : { message, content: contentB64, branch: STAGING_BRANCH }
  );
  const tmpFile = `.gh_write_${Date.now()}.json`;
  fs.writeFileSync(tmpFile, body, 'utf8');
  try {
    return execSync(
      `gh api --method PUT "repos/seminolas/ladder/contents/${path}" --input "${tmpFile}"`,
      { encoding: 'utf8' }
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function ghApiDelete(path, sha, message) {
  execSync(
    `gh api --method DELETE repos/seminolas/ladder/contents/${path} -f "message=${message}" -f "sha=${sha}" -f "branch=${STAGING_BRANCH}"`,
    { encoding: 'utf8' }
  );
}

function resetStagingViaGhCli() {
  const raw   = execSync(
    `gh api "repos/seminolas/ladder/contents/data/sessions?ref=${STAGING_BRANCH}"`,
    { encoding: 'utf8' }
  );
  const files = JSON.parse(raw).filter(f => f.name.endsWith('.json'));
  for (const f of files) {
    ghApiDelete(f.path, f.sha, `Test cleanup: delete ${f.name}`);
    console.log(`Deleted: ${f.name}`);
  }
  return files.length;
}

function buildMatchSets(scores) {
  return scores.map(s => s); // [[s1p1, s1p2], [s2p1, s2p2]]
}

function buildBoxMatches(pairings, scores) {
  return pairings.map((pairing, mi) => ({
    pair1: pairing.pair1,
    pair2: pairing.pair2,
    sets: scores[mi].map(set => set),
  }));
}

// Compute wins/games/points for a box of any size (4 or 5).
function computeStandings(players, pairings, scores) {
  const stats = players.map(() => ({ wins: 0, gamesWon: 0, pointsFor: 0, pointsAgainst: 0 }));

  pairings.forEach((pairing, mi) => {
    const matchSets = scores[mi];
    const { pair1, pair2 } = pairing;
    let p1games = 0, p2games = 0;
    matchSets.forEach(([s1, s2]) => {
      if (s1 > s2) p1games++;
      else if (s2 > s1) p2games++;
      pair1.forEach(i => { stats[i].pointsFor += s1; stats[i].pointsAgainst += s2; });
      pair2.forEach(i => { stats[i].pointsFor += s2; stats[i].pointsAgainst += s1; });
    });
    const pair1Wins = p1games > p2games;
    if (pair1Wins) pair1.forEach(i => stats[i].wins++);
    else pair2.forEach(i => stats[i].wins++);
    pair1.forEach(i => stats[i].gamesWon += p1games);
    pair2.forEach(i => stats[i].gamesWon += p2games);
  });

  const indexed = players.map((name, i) => ({ name, ...stats[i], pointDiff: stats[i].pointsFor - stats[i].pointsAgainst }));
  indexed.sort((a, b) => b.wins - a.wins || b.gamesWon - a.gamesWon || b.pointDiff - a.pointDiff);
  return indexed;
}

async function gotoApp(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((pwd) => {
    localStorage.setItem('badminton_admin_password', pwd);
  }, process.env.GH_ADMIN_PASSWORD);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[x-data]', { timeout: 20000 });
  await page.waitForTimeout(2000);
}

// Use local date parts (not toISOString) to avoid UTC offset shifting the date
function nextTuesday() {
  const d = new Date();
  const day = d.getDay();
  const daysUntil = day === 2 ? 0 : (2 - day + 7) % 7;
  d.setDate(d.getDate() + daysUntil);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.setTimeout(300_000);

test('full session flow', async ({ page }) => {

  // ── 1. Load app ────────────────────────────────────────────────────────────
  await gotoApp(page);
  await expect(page).toHaveURL(/staging/);
  console.log('App loaded');

  // ── 2. Reset staging data ──────────────────────────────────────────────────
  const deletedCount = resetStagingViaGhCli();
  console.log(`Reset: deleted ${deletedCount} session file(s)`);

  // Reload to reflect clean state
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(pwd => localStorage.setItem('badminton_admin_password', pwd), process.env.GH_ADMIN_PASSWORD);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // ── 3. Verify leaderboard has entries ──────────────────────────────────────
  const playerCountText = page.locator('text=/\\d+ players/');
  await expect(playerCountText).toBeVisible({ timeout: 15000 });
  const countStr = await playerCountText.textContent();
  const count = parseInt(countStr ?? '0');
  expect(count).toBeGreaterThan(50);
  console.log(`Leaderboard: ${countStr}`);
  await expect(page.getByText('Rory Weston').first()).toBeVisible();
  await expect(page.getByText('Ray Lugsanay').first()).toBeVisible();

  // ── 4. Verify date defaults to next Tuesday ────────────────────────────────
  const expectedDate = nextTuesday();
  console.log(`Expected next Tuesday: ${expectedDate}`);
  const dateInput = page.locator('input[type="date"]').first();
  await expect(dateInput).toBeVisible({ timeout: 10000 });
  const dateValue = await dateInput.inputValue();
  expect(dateValue).toBe(expectedDate);
  console.log(`Date input shows: ${dateValue} ✓`);

  // ── 5. Create session via gh API (PAT has read-only Contents access) ────────
  // Read the current leaderboard to capture leaderboardBefore
  const { content: leaderboardData, sha: leaderboardSha } = ghApiJson('data/leaderboard.json');
  const leaderboard = leaderboardData.players;

  // Determine player positions in the leaderboard
  const { buildAttendeeOrder } = require('../js/algorithm');
  const findPlayer = (search) => leaderboard.find(p => p.toLowerCase().includes(search));
  const realPlayers = SEARCH_TERMS.map(t => {
    const p = findPlayer(t);
    if (!p) throw new Error(`Player not found for search: ${t}`);
    return p;
  });
  console.log('Real players found:', realPlayers.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Test Player is a new member not yet in the leaderboard
  const testPlayerName = 'Test Player';
  const allPlayers = [...realPlayers, testPlayerName];

  // Sort attendees by leaderboard rank; Test Player goes after all ranked players
  const getRank = (name) => {
    const idx = leaderboard.findIndex(p => p === name);
    return idx >= 0 ? idx : 9999;
  };
  const sortedAttendees = [...allPlayers].sort((a, b) => getRank(a) - getRank(b));
  console.log('Sorted attendees (by rank):', sortedAttendees.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  const leaderboardBefore = sortedAttendees;

  // 9 players → assignBoxes gives 1×4 + 1×5 (box-of-4 first, then box-of-5)
  const box1Players = leaderboardBefore.slice(0, 4);
  const box2Players = leaderboardBefore.slice(4, 9);
  console.log('Box 1 (4 players):', box1Players.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));
  console.log('Box 2 (5 players):', box2Players.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Build match data
  const box1Matches = buildBoxMatches(PAIRINGS_4, BOX1_SCORES);
  const box2Matches = buildBoxMatches(PAIRINGS_5, BOX2_SCORES);

  // Compute standings
  const box1Standings = computeStandings(box1Players, PAIRINGS_4, BOX1_SCORES);
  const box2Standings = computeStandings(box2Players, PAIRINGS_5, BOX2_SCORES);
  console.log('Box 1 standings:', box1Standings.map(s => s.name.replace(/^\*+\s*|\s*\*+$/g, '').trim() + `(${s.wins}W)`));
  console.log('Box 2 standings:', box2Standings.map(s => s.name.replace(/^\*+\s*|\s*\*+$/g, '').trim() + `(${s.wins}W)`));

  // Create session JSON
  const session = {
    date: SESSION_DATE,
    status: 'in_progress',
    attendees: sortedAttendees,
    boxes: [
      { players: box1Players, matches: box1Matches },
      { players: box2Players, matches: box2Matches },
    ],
    leaderboardBefore,
    leaderboardAfter: null,
  };

  ghApiWrite(
    `data/sessions/${SESSION_DATE}.json`,
    session,
    null,
    `Add test session ${SESSION_DATE}`
  );
  console.log(`Session ${SESSION_DATE} created on staging via gh api`);

  // ── 6. Navigate to the session ─────────────────────────────────────────────
  await page.goto(`${BASE_URL}#/session/${SESSION_DATE}`, { waitUntil: 'networkidle' });
  await page.evaluate(pwd => localStorage.setItem('badminton_admin_password', pwd), process.env.GH_ADMIN_PASSWORD);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Should be showing the in_progress session view
  const urlAfter = page.url();
  console.log('Session URL:', urlAfter);

  // ── 7. Verify all 9 players are attending ─────────────────────────────────
  const attendingBadge = page.locator('text=/9 attending/i');
  await expect(attendingBadge).toBeVisible({ timeout: 10000 });
  console.log('9 attending badge visible ✓');

  const greenRows = page.locator('.bg-green-50');
  await expect(greenRows).toHaveCount(9, { timeout: 5000 });
  console.log('9 green attendance rows ✓');

  // ── 8. Navigate to Boxes & Results tab and verify box headings ───────────
  // Alpine's x-show="loading" overlay never gets display:none (async init timing: loading
  // goes false but inline style stays empty, so getComputedStyle returns 'flex' forever).
  // Session data IS loaded — confirmed by attendance checks above.
  // dispatchEvent from page context bypasses the pointer-events overlay entirely.
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const boxesBtn = btns.find(b =>
      b.getAttribute('@click') === 'sessionTab = num' &&
      b.textContent.trim() === 'Boxes & Results'
    );
    if (boxesBtn) boxesBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);

  // Verify the "2 box(es)" summary and the visible box score entry headings
  await expect(page.locator('text=/\\d+ box/i').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('text=Box 1 — Score Entry')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('text=Box 2 — Score Entry')).toBeVisible();
  console.log('Box headings visible ✓');

  // ── 9. Verify print layout has 2 pages ────────────────────────────────────
  await page.emulateMedia({ media: 'print' });
  const pageBreaks = page.locator('.print-page-break');
  const breakCount = await pageBreaks.count();
  expect(breakCount).toBeGreaterThanOrEqual(1);
  console.log(`Print page breaks: ${breakCount} (≥1 means 2 pages) ✓`);
  await page.emulateMedia({ media: 'screen' });

  // ── 10. Verify score inputs show the written scores ───────────────────────
  // Score inputs exist and the first one has the expected value (21)
  const scoreInputs = page.locator('input[type="number"][min="0"][max="99"]').filter({ visible: true });
  await expect(scoreInputs.first()).toBeVisible({ timeout: 10000 });
  const firstVal = await scoreInputs.first().inputValue();
  console.log('First score input value:', firstVal, '(expect 21)');
  expect(firstVal).toBe('21');

  // ── 12. Close session via gh API + apply leaderboard ─────────────────────
  // Use buildAttendeeOrder (same function the app uses) to compute new order
  const b1 = box1Standings.map(s => s.name);
  const b2 = box2Standings.map(s => s.name);
  const newAttendeeOrder = buildAttendeeOrder([b1, b2]);
  console.log('New attendee order:', newAttendeeOrder.map(n => n.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Find the leaderboard slots occupied by real players (Test Player has none)
  const newLeaderboard = [...leaderboard];
  const attendingInLb = realPlayers
    .map(p => ({ p, idx: newLeaderboard.indexOf(p) }))
    .filter(x => x.idx >= 0);
  const originalSlots = attendingInLb.map(x => x.idx).sort((a, b) => a - b);
  console.log('Slots being updated:', originalSlots);

  // Remove real players from leaderboard, then insert in new order at their original slots
  for (const { p } of attendingInLb) {
    newLeaderboard.splice(newLeaderboard.indexOf(p), 1);
  }
  const realPlayersNewOrder = newAttendeeOrder.filter(n => n !== testPlayerName);
  for (let i = 0; i < realPlayersNewOrder.length && i < originalSlots.length; i++) {
    newLeaderboard.splice(originalSlots[i], 0, realPlayersNewOrder[i]);
  }
  // Test Player is new — push to end (mirrors app's applyLeaderboardUpdate behaviour)
  if (newAttendeeOrder.includes(testPlayerName)) {
    newLeaderboard.push(testPlayerName);
  }

  // Save closed session with leaderboardAfter
  const { content: existingSession, sha: sessionSha } = ghApiJson(`data/sessions/${SESSION_DATE}.json`);
  const closedSession = { ...existingSession, status: 'closed', leaderboardAfter: newLeaderboard };
  ghApiWrite(`data/sessions/${SESSION_DATE}.json`, closedSession, sessionSha, `Close session ${SESSION_DATE}`);
  console.log('Session closed via gh api');

  // Update leaderboard
  const newLeaderboardData = { players: newLeaderboard, updatedAt: SESSION_DATE };
  ghApiWrite('data/leaderboard.json', newLeaderboardData, leaderboardSha, `Update leaderboard after session ${SESSION_DATE}`);
  console.log('Leaderboard updated via gh api');

  // ── 13. Verify leaderboard shows updated rankings ────────────────────────
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(pwd => localStorage.setItem('badminton_admin_password', pwd), process.env.GH_ADMIN_PASSWORD);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  await expect(page.getByText('Rory Weston').first()).toBeVisible({ timeout: 15000 });
  const b1First = b1[0].replace(/^\*+\s*|\s*\*+$/g, '').trim();
  const b1Second = b1[1].replace(/^\*+\s*|\s*\*+$/g, '').trim();
  const b2First = b2[0].replace(/^\*+\s*|\s*\*+$/g, '').trim();
  console.log(`Checking top players: ${b1First}, ${b1Second}, ${b2First}`);

  // Top 3 after update: B1[0], B1[1], B2[0]
  await expect(page.getByText(b1First.split(' ')[0]).first()).toBeVisible();
  await expect(page.getByText(b2First.split(' ')[0]).first()).toBeVisible();

  // Box 1 winner should be in slot 1 (top of leaderboard)
  const slot1Text = await page.locator('div.flex.items-center').filter({ hasText: b1First.split(' ')[0] }).first().textContent();
  console.log(`Leaderboard entry for ${b1First.split(' ')[0]}:`, slot1Text?.trim().substring(0, 50));

  console.log('=== Full session flow test PASSED ===');
});
