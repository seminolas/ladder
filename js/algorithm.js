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
      if (s1 > s2) p1Sets++;
      else if (s2 > s1) p2Sets++;

      for (const pi of pair1) {
        stats[pi].pointsFor += s1;
        stats[pi].pointsAgainst += s2;
      }
      for (const pi of pair2) {
        stats[pi].pointsFor += s2;
        stats[pi].pointsAgainst += s1;
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

// Determine whether all matches in all boxes have complete scores.
function allScoresComplete(boxes) {
  for (const box of boxes) {
    if (box.edgeCase) continue;
    for (const match of box.matches) {
      if (!match.sets || match.sets.length === 0) return false;
      for (const [s1, s2] of match.sets) {
        if (s1 == null || s2 == null || s1 === '' || s2 === '') return false;
      }
    }
  }
  return true;
}

// Build new leaderboard by applying 2-up-2-down to attending players.
// Non-attending players keep their absolute positions.
// Pattern for pairs of boxes: B1_1, B1_2, B2_1, B2_2, B1_rest..., B2_rest...
// In a box-of-5: 3rd place is treated as neutral (inserted in middle of their pair-group).
function applyLeaderboardUpdate(boxes, leaderboardBefore) {
  // Sort each box's players by their final placing
  const boxRankings = boxes.map(box => {
    const standings = computeBoxStandings(box, leaderboardBefore);
    return standings.map(s => s.name);
  });

  const newAttendeeOrder = [];

  for (let i = 0; i < boxRankings.length; i += 2) {
    const b1 = boxRankings[i];
    const b2 = i + 1 < boxRankings.length ? boxRankings[i + 1] : [];
    const b1Size = boxes[i].players.length;
    const b2Size = b2.length > 0 ? boxes[i + 1].players.length : 0;

    // Top 2 from b1, top 2 from b2
    newAttendeeOrder.push(b1[0]);
    if (b1[1] !== undefined) newAttendeeOrder.push(b1[1]);
    if (b2[0] !== undefined) newAttendeeOrder.push(b2[0]);
    if (b2[1] !== undefined) newAttendeeOrder.push(b2[1]);

    // 3rd place from b1 if box-of-5 (neutral — stays in middle)
    if (b1Size === 5 && b1[2] !== undefined) newAttendeeOrder.push(b1[2]);

    // Remaining from b1 (index 2 for box-of-4, index 3 for box-of-5)
    const b1Start = b1Size === 5 ? 3 : 2;
    for (let j = b1Start; j < b1.length; j++) newAttendeeOrder.push(b1[j]);

    // 3rd place from b2 if box-of-5
    if (b2Size === 5 && b2[2] !== undefined) newAttendeeOrder.push(b2[2]);

    // Remaining from b2
    const b2Start = b2Size === 5 ? 3 : 2;
    for (let j = b2Start; j < b2.length; j++) newAttendeeOrder.push(b2[j]);
  }

  // Gather all attendees and their current leaderboard slot indices (sorted)
  const allAttendees = boxes.flatMap(b => b.players);
  const attendeeSlots = allAttendees
    .map(name => leaderboardBefore.indexOf(name))
    .filter(i => i !== -1)
    .sort((a, b) => a - b);

  // New attendees might include players added mid-session not in leaderboardBefore
  // Place them at end if so
  const newLeaderboard = [...leaderboardBefore];
  newAttendeeOrder.forEach((name, i) => {
    if (i < attendeeSlots.length) {
      newLeaderboard[attendeeSlots[i]] = name;
    } else {
      newLeaderboard.push(name); // new player not in previous leaderboard
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
