// Match pairings from the PDF score sheets (0-indexed players)
const PAIRINGS_4 = [
  { pair1: [0,1], pair2: [2,3] },
  { pair1: [0,2], pair2: [1,3] },
  { pair1: [0,3], pair2: [1,2] },
];

const PAIRINGS_5 = [
  { pair1: [0,1], pair2: [2,4] },
  { pair1: [2,3], pair2: [1,4] },
  { pair1: [3,4], pair2: [0,2] },
  { pair1: [0,3], pair2: [1,2] },
  { pair1: [1,3], pair2: [0,4] },
];

// Which player index sits out each match in a box of 5
const SITOUT_5 = [3, 0, 1, 4, 2];

function getPairings(size) {
  if (size === 4) return PAIRINGS_4.map(p => ({ ...p, sets: [] }));
  if (size === 5) return PAIRINGS_5.map(p => ({ ...p, sets: [] }));
  // Fallback for unusual sizes: no matches defined
  return [];
}

// Divide attendees (in leaderboard order) into boxes.
// Boxes of 4 come first, boxes of 5 come last.
// Returns array of box objects.
function assignBoxes(attendees) {
  const n = attendees.length;
  let numFours = 0, numFives = 0;

  for (let a = Math.floor(n / 4); a >= 0; a--) {
    const rem = n - 4 * a;
    if (rem >= 0 && rem % 5 === 0) {
      numFours = a;
      numFives = rem / 5;
      break;
    }
  }

  // Edge case: 6 or 7 players can't split into 4s and 5s
  // Put them in one box and flag it
  if (numFours === 0 && numFives === 0) {
    return [{ players: [...attendees], matches: [], edgeCase: true, finalPlacings: null }];
  }

  const boxes = [];
  let idx = 0;
  for (let i = 0; i < numFours; i++) {
    boxes.push({ players: attendees.slice(idx, idx + 4), matches: getPairings(4), finalPlacings: null });
    idx += 4;
  }
  for (let i = 0; i < numFives; i++) {
    boxes.push({ players: attendees.slice(idx, idx + 5), matches: getPairings(5), finalPlacings: null });
    idx += 5;
  }
  return boxes;
}

// Compute per-player standings for a single box.
// leaderboardBefore used only for the final tiebreak.
// Returns array of stat objects sorted by placing (1st first).
function computeBoxStandings(box, leaderboardBefore) {
  const stats = box.players.map((name, i) => ({
    playerIdx: i,
    name,
    matchesWon: 0,
    setsWon: 0,
    setsLost: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    leaderboardPos: leaderboardBefore ? leaderboardBefore.indexOf(name) : i,
  }));

  for (const match of box.matches) {
    const { pair1, pair2, sets } = match;
    if (!sets || sets.length === 0) continue;

    let p1Sets = 0, p2Sets = 0;
    for (const [s1, s2] of sets) {
      if (s1 === '' || s1 == null || s2 === '' || s2 == null) continue;
      const n1 = Number(s1), n2 = Number(s2);
      if (n1 > n2) p1Sets++;
      else if (n2 > n1) p2Sets++;

      for (const pi of pair1) {
        stats[pi].pointsFor += n1;
        stats[pi].pointsAgainst += n2;
      }
      for (const pi of pair2) {
        stats[pi].pointsFor += n2;
        stats[pi].pointsAgainst += n1;
      }
    }

    for (const pi of pair1) {
      stats[pi].setsWon += p1Sets;
      stats[pi].setsLost += p2Sets;
    }
    for (const pi of pair2) {
      stats[pi].setsWon += p2Sets;
      stats[pi].setsLost += p1Sets;
    }

    if (p1Sets > p2Sets) {
      for (const pi of pair1) stats[pi].matchesWon++;
    } else if (p2Sets > p1Sets) {
      for (const pi of pair2) stats[pi].matchesWon++;
    }
  }

  stats.sort((a, b) => {
    if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
    const dSets = (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost);
    if (dSets !== 0) return dSets;
    const dPts = (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst);
    if (dPts !== 0) return dPts;
    return a.leaderboardPos - b.leaderboardPos; // higher rank (lower index) wins tie
  });

  stats.forEach((s, i) => { s.placing = i + 1; });
  return stats;
}

// ── Score validation ──────────────────────────────────────────────────────────

// Valid badminton set: first to 21 (lead ≥2), deuce extension up to 30-28,
// cap at 30-29 (at 29-29 the next point wins regardless of 2-point rule).
function isValidSet(a, b) {
  a = Number(a); b = Number(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  if (a === b) return false;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi === 21 && lo <= 19) return true;
  if (lo >= 20 && hi === lo + 2 && hi <= 30) return true;
  if (hi === 30 && lo === 29) return true;
  return false;
}

// True when both scores are present and form a valid set result.
function isSetComplete(a, b) {
  if (a === '' || a == null || b === '' || b == null) return false;
  return isValidSet(a, b);
}

// Classify a match by its current scoring state.
// 'not_started' — no scores entered at all
// 'in_progress' — some scores entered but no winner yet
// 'invalid'     — at least one set has both scores entered but they are illegal
// 'complete'    — one pair has won 2 sets and all entered sets are valid
function getMatchStatus(match) {
  const sets = match.sets || [];
  let anySetsEntered = false;
  let hasInvalid = false;
  let pair1Sets = 0, pair2Sets = 0;

  for (const s of sets) {
    const aEmpty = s[0] === '' || s[0] == null;
    const bEmpty = s[1] === '' || s[1] == null;
    if (aEmpty && bEmpty) continue;
    anySetsEntered = true;
    if (aEmpty || bEmpty) return 'in_progress';
    if (!isValidSet(s[0], s[1])) {
      hasInvalid = true;
    } else {
      if (Number(s[0]) > Number(s[1])) pair1Sets++;
      else pair2Sets++;
    }
  }

  if (!anySetsEntered) return 'not_started';
  if (hasInvalid) return 'invalid';
  if (pair1Sets >= 2 || pair2Sets >= 2) return 'complete';
  return 'in_progress';
}

// Determine whether all matches in all boxes are complete with valid scores.
function allScoresComplete(boxes) {
  for (const box of boxes) {
    if (box.edgeCase) continue;
    for (const match of box.matches) {
      if (getMatchStatus(match) !== 'complete') return false;
    }
  }
  return true;
}

// Given boxes already sorted by result (1st place first), build the new attendee
// order by cascading 2-up-2-down across every adjacent pair of boxes.
//
// Rule: for every adjacent pair (curr, next):
//   - next's top 2 promote into curr's territory
//   - curr's bottom 2 demote into next's territory
//   - curr's "neutral zone" = everyone except its bottom 2 (box-of-4: none; box-of-5: 1; box-of-6: 2; box-of-7: 3)
//
// The last box has no lower neighbour so its bottom 2 stay in place.
function buildAttendeeOrder(sortedBoxes) {
  if (sortedBoxes.length === 0) return [];

  const order = [];

  // First box: everyone except the bottom 2 stays in this box's territory.
  order.push(...sortedBoxes[0].slice(0, -2));

  for (let i = 0; i + 1 < sortedBoxes.length; i++) {
    const curr = sortedBoxes[i];
    const next = sortedBoxes[i + 1];

    order.push(next[0], next[1]);         // next's top 2 promote into curr's bottom
    order.push(...curr.slice(-2));         // curr's bottom 2 demote into next's top
    order.push(...next.slice(2, -2));      // next's neutral zone (empty for box-of-4)
  }

  // Last box: bottom 2 stay (nothing below to demote into).
  order.push(...sortedBoxes[sortedBoxes.length - 1].slice(-2));

  return order;
}

// Build new leaderboard by applying 2-up-2-down to attending players.
// Non-attending players keep their absolute positions.
function applyLeaderboardUpdate(boxes, leaderboardBefore) {
  const sortedBoxes = boxes.map(box => {
    const standings = computeBoxStandings(box, leaderboardBefore);
    return standings.map(s => s.name);
  });

  const newAttendeeOrder = buildAttendeeOrder(sortedBoxes);

  // Gather the leaderboard slots occupied by all attendees (sorted by position).
  const allAttendees = boxes.flatMap(b => b.players);
  const attendeeSlots = allAttendees
    .map(name => leaderboardBefore.indexOf(name))
    .filter(i => i !== -1)
    .sort((a, b) => a - b);

  const newLeaderboard = [...leaderboardBefore];
  newAttendeeOrder.forEach((name, i) => {
    if (i < attendeeSlots.length) {
      newLeaderboard[attendeeSlots[i]] = name;
    } else {
      newLeaderboard.push(name); // new player added mid-session
    }
  });

  return newLeaderboard;
}

// Returns the next Tuesday from today (or today if today is Tuesday).
function nextTuesday(fromDate) {
  const d = fromDate ? new Date(fromDate) : new Date();
  const day = d.getDay();
  const daysUntilTuesday = day === 2 ? 0 : (2 - day + 7) % 7;
  d.setDate(d.getDate() + daysUntilTuesday);
  // Use local date parts to avoid UTC offset issues (important for NZ timezone)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Format date as "Tue 10 Jun 2026"
function formatDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

if (typeof module !== 'undefined') {
  module.exports = {
    getPairings,
    assignBoxes,
    computeBoxStandings,
    isValidSet,
    isSetComplete,
    getMatchStatus,
    allScoresComplete,
    buildAttendeeOrder,
    applyLeaderboardUpdate,
    nextTuesday,
    formatDate,
  };
}
