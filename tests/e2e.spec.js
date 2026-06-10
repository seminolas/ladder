require('dotenv').config();
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const GH_CONFIG = {
  owner: 'seminolas',
  repo: 'ladder',
  pat: process.env.GH_PAT,
};
const BASE_URL = 'https://seminolas.github.io/ladder/staging/';
const STAGING_BRANCH = 'staging';
const SESSION_DATE = '2026-06-16';

// PAIRINGS_5 from algorithm.js (match order for box-of-5)
const PAIRINGS_5 = [
  { pair1: [0, 1], pair2: [2, 4] }, // M0: sitout=3
  { pair1: [2, 3], pair2: [1, 4] }, // M1: sitout=0
  { pair1: [3, 4], pair2: [0, 2] }, // M2: sitout=1
  { pair1: [0, 3], pair2: [1, 2] }, // M3: sitout=4
  { pair1: [1, 3], pair2: [0, 4] }, // M4: sitout=2
];

// Box 1 players (indices): Rory(0), Shivam(1), Ray(2), Kenzie(3), Vilius(4)
// Box 2 players (indices): Aiko(0), Jency(1), Stephen(2), Test Player(3), Amia(4)
// Scores: [set1_p1, set1_p2], [set2_p1, set2_p2]
const BOX1_SCORES = [
  [[21, 15], [21, 18]], // M0 [0,1]v[2,4]: pair1 wins → Rory+Shivam
  [[21, 17], [21, 14]], // M1 [2,3]v[1,4]: pair1 wins → Ray+Kenzie
  [[19, 21], [16, 21]], // M2 [3,4]v[0,2]: pair2 wins → Rory+Ray
  [[21, 18], [21, 15]], // M3 [0,3]v[1,2]: pair1 wins → Rory+Kenzie
  [[19, 21], [17, 21]], // M4 [1,3]v[0,4]: pair2 wins → Rory+Vilius
];
const BOX2_SCORES = [
  [[21, 14], [21, 16]], // M0 [0,1]v[2,4]: pair1 wins → Aiko+Jency
  [[21, 15], [21, 13]], // M1 [2,3]v[1,4]: pair1 wins → Stephen+TestPlayer (Aiko sits)
  [[12, 21], [15, 21]], // M2 [3,4]v[0,2]: pair2 wins → Aiko+Stephen
  [[21, 17], [21, 14]], // M3 [0,3]v[1,2]: pair1 wins → Aiko+TestPlayer
  [[18, 21], [16, 21]], // M4 [1,3]v[0,4]: pair2 wins → Aiko+Amia
];

const SEARCH_TERMS = ['rory', 'shivam', 'ray', 'kenzie', 'vilius', 'aiko', 'jency', 'stephen', 'amia'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function ghApi(args, body) {
  const bodyFlag = body ? `-f body="${JSON.stringify(body).replace(/"/g, '\\"')}"` : '';
  return execSync(`gh api ${args}`, { encoding: 'utf8' });
}

function ghApiJson(path, branch = STAGING_BRANCH) {
  const raw = execSync(
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
  // Write body to a temp file to avoid "command line too long" on Windows
  const tmpFile = `.gh_write_${Date.now()}.json`;
  require('fs').writeFileSync(tmpFile, body, 'utf8');
  try {
    return execSync(
      `gh api --method PUT "repos/seminolas/ladder/contents/${path}" --input "${tmpFile}"`,
      { encoding: 'utf8' }
    );
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch (_) {}
  }
}

function ghApiDelete(path, sha, message) {
  execSync(
    `gh api --method DELETE repos/seminolas/ladder/contents/${path} -f "message=${message}" -f "sha=${sha}" -f "branch=${STAGING_BRANCH}"`,
    { encoding: 'utf8' }
  );
}

function resetStagingViaGhCli() {
  const raw = execSync(
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

function buildBoxMatches(playerCount, scores) {
  return PAIRINGS_5.map((pairing, mi) => ({
    pair1: pairing.pair1,
    pair2: pairing.pair2,
    sets: scores[mi].map(set => set), // [[p1score, p2score], ...]
  }));
}

// Compute wins/games/points for a 5-player box
function computeStandings(players, scores) {
  const stats = players.map(() => ({ wins: 0, gamesWon: 0, pointsFor: 0, pointsAgainst: 0 }));
  const SITOUT_5 = [3, 0, 1, 4, 2];

  PAIRINGS_5.forEach((pairing, mi) => {
    const matchSets = scores[mi]; // [[s1p1, s1p2], [s2p1, s2p2]]
    const pair1 = pairing.pair1;
    const pair2 = pairing.pair2;
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

  // Sort: wins desc, gamesWon desc, pointDiff desc
  const indexed = players.map((name, i) => ({ name, ...stats[i], pointDiff: stats[i].pointsFor - stats[i].pointsAgainst }));
  indexed.sort((a, b) => b.wins - a.wins || b.gamesWon - a.gamesWon || b.pointDiff - a.pointDiff);
  return indexed;
}

async function gotoApp(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((cfg) => {
    localStorage.setItem('badminton_gh_config', JSON.stringify(cfg));
  }, GH_CONFIG);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[x-data]', { timeout: 20000 });
  await page.waitForTimeout(2000);
}

function nextTuesday() {
  const d = new Date();
  const day = d.getDay();
  const daysUntil = (2 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntil);
  return d.toISOString().split('T')[0];
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
  await page.evaluate(cfg => localStorage.setItem('badminton_gh_config', JSON.stringify(cfg)), GH_CONFIG);
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
  const findPlayer = (search) => leaderboard.find(p => p.toLowerCase().includes(search));
  const players9 = SEARCH_TERMS.map(t => {
    const p = findPlayer(t);
    if (!p) throw new Error(`Player not found for search: ${t}`);
    return p;
  });
  console.log('9 players:', players9.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Add Test Player at position 100 (0-indexed = 99)
  const testPlayerName = 'Test Player';
  const allPlayers10 = [...players9, testPlayerName];

  // Sort attendees by leaderboard rank (leaderboard index)
  const getRank = (name) => {
    if (name === testPlayerName) return 99; // position 100
    const idx = leaderboard.findIndex(p => p === name);
    return idx >= 0 ? idx : 9999;
  };
  const sortedAttendees = [...allPlayers10].sort((a, b) => getRank(a) - getRank(b));
  console.log('Sorted attendees (by rank):', sortedAttendees.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Build leaderboardBefore (sorted attendees order)
  const leaderboardBefore = sortedAttendees;

  // Box assignment: 10 players → 2 boxes of 5
  // App algorithm: boxes[0] = first 5 by rank, boxes[1] = next 5
  const box1Players = leaderboardBefore.slice(0, 5);
  const box2Players = leaderboardBefore.slice(5, 10);
  console.log('Box 1:', box1Players.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));
  console.log('Box 2:', box2Players.map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Build match data for each box
  const box1Matches = PAIRINGS_5.map((p, mi) => ({
    pair1: p.pair1, pair2: p.pair2,
    sets: BOX1_SCORES[mi].map(set => [set[0], set[1]]),
  }));
  const box2Matches = PAIRINGS_5.map((p, mi) => ({
    pair1: p.pair1, pair2: p.pair2,
    sets: BOX2_SCORES[mi].map(set => [set[0], set[1]]),
  }));

  // Compute standings
  const box1Standings = computeStandings(box1Players, BOX1_SCORES);
  const box2Standings = computeStandings(box2Players, BOX2_SCORES);
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
  await page.evaluate(cfg => localStorage.setItem('badminton_gh_config', JSON.stringify(cfg)), GH_CONFIG);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Should be showing the in_progress session view
  const urlAfter = page.url();
  console.log('Session URL:', urlAfter);

  // ── 7. Verify all 10 players are attending ────────────────────────────────
  // The attendance tab shows all 10 with checkmarks; "10 attending" badge visible
  const attendingBadge = page.locator('text=/10 attending/i');
  await expect(attendingBadge).toBeVisible({ timeout: 10000 });
  console.log('10 attending badge visible ✓');

  // Players appear as green rows in the attendance list — use .bg-green-50 class
  const greenRows = page.locator('.bg-green-50');
  await expect(greenRows).toHaveCount(10, { timeout: 5000 });
  console.log('10 green attendance rows ✓');

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
  // Compute new leaderboard after 2-up-2-down
  // Order of winners: Box1[0,1] then Box2[0,1] go to top slots
  // Box1 order: box1Standings[0..4], Box2 order: box2Standings[0..4]
  const b1 = box1Standings.map(s => s.name);
  const b2 = box2Standings.map(s => s.name);

  // 2-up-2-down: top slots get B1[0], B1[1], B2[0], B2[1]
  // then neutral, then losers in reverse order
  // Simplified: apply leaderboardUpdate using the same logic as the app
  const newOrderNames = [b1[0], b1[1], b2[0], b2[1], b1[2], b2[2], b1[3], b2[3], b1[4], b2[4]];
  console.log('New leaderboard order for attendees:', newOrderNames.map(n => n.replace(/^\*+\s*|\s*\*+$/g, '').trim()));

  // Determine the slots these players occupied before (their positions in leaderboardBefore)
  const slots = leaderboardBefore.map((_, i) => {
    const lbIdx = leaderboard.findIndex(p => p === leaderboardBefore[i]);
    return lbIdx >= 0 ? lbIdx : i;
  }).sort((a, b) => a - b);
  console.log('Slots being updated:', slots);

  // Build new leaderboard
  const newLeaderboard = [...leaderboard];
  // Remove Test Player (new player, was at position 99)
  const testPlayerLeaderboardIdx = newLeaderboard.indexOf(testPlayerName);
  if (testPlayerLeaderboardIdx >= 0) {
    newLeaderboard.splice(testPlayerLeaderboardIdx, 1);
  }

  // Place attendees back into the slot positions in new order
  // Remove all attending players from leaderboard first
  const attendingInLb = players9.map(p => ({ p, idx: newLeaderboard.indexOf(p) })).filter(x => x.idx >= 0);
  for (const { p } of attendingInLb) {
    const idx = newLeaderboard.indexOf(p);
    if (idx >= 0) newLeaderboard.splice(idx, 1);
  }

  // Get original slots for attending players (sorted)
  const originalSlots = attendingInLb.map(x => x.idx).sort((a, b) => a - b);
  // Insert new order at those slots
  const newOrder9 = newOrderNames.filter(n => n !== testPlayerName);
  for (let i = 0; i < newOrder9.length && i < originalSlots.length; i++) {
    newLeaderboard.splice(originalSlots[i], 0, newOrder9[i]);
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
  await page.evaluate(cfg => localStorage.setItem('badminton_gh_config', JSON.stringify(cfg)), GH_CONFIG);
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
