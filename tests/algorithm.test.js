// Unit tests for js/algorithm.js
// Run with: node --test tests/algorithm.test.js
//
// Each test shows the movement pattern in a comment like:
//   Slots: 0  1  2  3  4  5  6  7
//   Δ:     0  0 +2 +2 -2 -2  0  0
// where slot numbers are leaderboard positions (lower = higher rank) and
// Δ is the change after applying the update.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAttendeeOrder,
  assignBoxes,
  computeBoxStandings,
  applyLeaderboardUpdate,
} = require('../js/algorithm');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a minimal box object ready for computeBoxStandings / applyLeaderboardUpdate.
// players: string[] in seeding order (index 0 = highest seed)
// finalRanking: string[] in result order (index 0 = winner)
// We fake the standings by setting finalPlacings directly and bypassing match scoring.
function makeBox(players) {
  return { players, matches: [], finalPlacings: null };
}

// Override computeBoxStandings for deterministic tests:
// pass standings as pre-sorted player arrays to buildAttendeeOrder directly,
// bypassing the scoring logic that we test separately.

// ---------------------------------------------------------------------------
// buildAttendeeOrder — the core cascade algorithm
// ---------------------------------------------------------------------------

describe('buildAttendeeOrder', () => {

  test('single box of 4 — no movement', () => {
    // Box-of-4: no neutral zone, no adjacent box → everyone stays.
    // Slots: 0  1  2  3
    // Δ:     0  0  0  0
    const order = buildAttendeeOrder([['A', 'B', 'C', 'D']]);
    assert.deepEqual(order, ['A', 'B', 'C', 'D']);
  });

  test('single box of 5 — no movement (1 neutral)', () => {
    // Box-of-5: 1 neutral zone player, no adjacent box → everyone stays.
    // Slots: 0  1  2  3  4
    // Δ:     0  0  0  0  0
    const order = buildAttendeeOrder([['A', 'B', 'C', 'D', 'E']]);
    assert.deepEqual(order, ['A', 'B', 'C', 'D', 'E']);
  });

  test('two boxes of 4 — standard 2-up 2-down', () => {
    // B1=[A,B,C,D]  B2=[E,F,G,H]
    // E,F promote (+2 each); C,D demote (-2 each); A,B,G,H stay.
    //
    // Slots:  0   1   2   3   4   5   6   7
    // Before: A   B   C   D   E   F   G   H
    // After:  A   B   E   F   C   D   G   H
    // Δ:      0   0  +2  +2  -2  -2   0   0
    const order = buildAttendeeOrder([
      ['A', 'B', 'C', 'D'],
      ['E', 'F', 'G', 'H'],
    ]);
    assert.deepEqual(order, ['A', 'B', 'E', 'F', 'C', 'D', 'G', 'H']);
  });

  test('two boxes of 5 — standard 2-up 2-down with 1 neutral each', () => {
    // B1=[P1..P5]  B2=[P6..P10]
    // P1,P2 stay top; P3 neutral (stays); P6,P7 promote; P4,P5 demote;
    // P8 neutral (stays); P9,P10 stay bottom.
    //
    // Slots:  0   1   2   3   4   5   6   7   8   9
    // Before: P1  P2  P3  P4  P5  P6  P7  P8  P9 P10
    // After:  P1  P2  P3  P6  P7  P4  P5  P8  P9 P10
    // Δ:       0   0   0  +2  +2  -2  -2   0   0   0
    const order = buildAttendeeOrder([
      ['P1', 'P2', 'P3', 'P4', 'P5'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
    ]);
    assert.deepEqual(order, ['P1', 'P2', 'P3', 'P6', 'P7', 'P4', 'P5', 'P8', 'P9', 'P10']);
  });

  test('three boxes of 5 — cascade across all three', () => {
    // Cascades: B1→B2 and B2→B3 independently.
    //
    // Slots:  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14
    // Before: P1  P2  P3  P4  P5  P6  P7  P8  P9 P10 P11 P12 P13 P14 P15
    // After:  P1  P2  P3  P6  P7  P4  P5  P8  P11 P12 P9 P10 P13 P14 P15
    // Δ:       0   0   0  +2  +2  -2  -2   0  +2  +2  -2  -2   0   0   0
    const order = buildAttendeeOrder([
      ['P1', 'P2', 'P3', 'P4', 'P5'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
      ['P11', 'P12', 'P13', 'P14', 'P15'],
    ]);
    assert.deepEqual(order, [
      'P1', 'P2', 'P3',           // B1 top 3 stay
      'P6', 'P7',                  // B2 top 2 promote
      'P4', 'P5',                  // B1 bottom 2 demote
      'P8',                        // B2 neutral stays
      'P11', 'P12',                // B3 top 2 promote
      'P9', 'P10',                 // B2 bottom 2 demote
      'P13',                       // B3 neutral stays
      'P14', 'P15',                // B3 bottom 2 stay
    ]);
  });

  test('three boxes of 4 — cascade, no neutral zones', () => {
    // Slots:  0   1   2   3   4   5   6   7   8  11
    // Before: A   B   C   D   E   F   G   H   I   J  K   L
    // Δ:      0   0  +2  +2  -2  -2  +2  +2  -2  -2   0   0
    const order = buildAttendeeOrder([
      ['A', 'B', 'C', 'D'],
      ['E', 'F', 'G', 'H'],
      ['I', 'J', 'K', 'L'],
    ]);
    assert.deepEqual(order, [
      'A', 'B',        // B1 top 2 stay
      'E', 'F',        // B2 top 2 promote
      'C', 'D',        // B1 bottom 2 demote
                       // no neutrals (box-of-4)
      'I', 'J',        // B3 top 2 promote
      'G', 'H',        // B2 bottom 2 demote
                       // no neutrals
      'K', 'L',        // B3 bottom 2 stay
    ]);
  });

  test('top seed finishes 3rd in box-of-5 — stays in place (does not fall)', () => {
    // The key bug that motivated this fix:
    // Box 1 top seed (P1) comes 3rd — they are in the "neutral zone" and must NOT
    // move down. Under the old algorithm they would drop 2 slots.
    //
    // B1 result order: [P2, P3, P1, P4, P5]  (P1 came 3rd)
    // B2 result order: [P6, P7, P8, P9, P10]
    //
    // Slots:  0   1   2   3   4   5   6   7   8   9
    // Before: P1  P2  P3  P4  P5  P6  P7  P8  P9 P10
    // After:  P2  P3  P1  P6  P7  P4  P5  P8  P9 P10
    // Δ:     +1  -1   0  +2  +2  -2  -2   0   0   0
    //         ^-- P1 stays at slot 2 (3rd) ✓
    const order = buildAttendeeOrder([
      ['P2', 'P3', 'P1', 'P4', 'P5'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
    ]);
    // P1 must be at index 2 (slot 2 = 3rd place territory, unchanged)
    assert.equal(order[2], 'P1', 'P1 (3rd in box-of-5) must occupy the neutral slot');
    assert.deepEqual(order, ['P2', 'P3', 'P1', 'P6', 'P7', 'P4', 'P5', 'P8', 'P9', 'P10']);
  });

  test('bottom seed finishes 3rd in box-of-5 — rises to neutral slot', () => {
    // P5 (bottom seed) comes 3rd → earns the neutral slot and rises 2.
    // P3/P4 came 4th/5th (demote zone) and drop, even though they were higher seeds.
    //
    // B1 result: [P1, P2, P5, P3, P4]   B2 result: [P6, P7, P8, P9, P10]
    //
    // Slots:  0   1   2   3   4   5   6   7   8   9
    // Before: P1  P2  P3  P4  P5  P6  P7  P8  P9 P10
    // After:  P1  P2  P5  P6  P7  P3  P4  P8  P9 P10
    // Δ:       0   0  -2  -2  -2  +3  +3   0   0   0
    //              P5 ↑ rises to neutral ✓   P3,P4 ↓ demoted (finished 4th/5th)
    const order = buildAttendeeOrder([
      ['P1', 'P2', 'P5', 'P3', 'P4'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
    ]);
    assert.equal(order[2], 'P5', 'P5 (3rd in box-of-5) must occupy the neutral slot');
    assert.deepEqual(order, ['P1', 'P2', 'P5', 'P6', 'P7', 'P3', 'P4', 'P8', 'P9', 'P10']);
  });

  test('bottom seed wins box-of-5 — climbs from last to top within box', () => {
    // B1 result: [P5, P4, P3, P2, P1]  (complete reversal)
    // B2 result: [P6, P7, P8, P9, P10] (normal)
    //
    // P5 wins B1 → takes slot 0 (climbs 4 within B1 territory).
    // P4 2nd → slot 1; P3 neutral → slot 2 (stays neutral).
    // P6, P7 promote → slots 3, 4.  P2, P1 demote → slots 5, 6.
    const order = buildAttendeeOrder([
      ['P5', 'P4', 'P3', 'P2', 'P1'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
    ]);
    assert.deepEqual(order, ['P5', 'P4', 'P3', 'P6', 'P7', 'P2', 'P1', 'P8', 'P9', 'P10']);
  });

  test('last-box bottom seed stays — no further demotion possible', () => {
    // P10 finishes last in the last box. They can't be demoted (no box below).
    // Confirm P10 is still in the output at a terminal position.
    const order = buildAttendeeOrder([
      ['P1', 'P2', 'P3', 'P4', 'P5'],
      ['P6', 'P7', 'P8', 'P9', 'P10'],
    ]);
    // P10 must appear at the very end
    assert.equal(order[order.length - 1], 'P10');
  });

  test('empty input returns empty array', () => {
    assert.deepEqual(buildAttendeeOrder([]), []);
  });

});

// ---------------------------------------------------------------------------
// assignBoxes — box allocation logic
// ---------------------------------------------------------------------------

describe('assignBoxes', () => {

  test('8 players → two boxes of 4', () => {
    const players = ['A','B','C','D','E','F','G','H'];
    const boxes = assignBoxes(players);
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes[0].players, ['A','B','C','D']);
    assert.deepEqual(boxes[1].players, ['E','F','G','H']);
  });

  test('10 players → two boxes of 5', () => {
    const players = Array.from({length: 10}, (_, i) => `P${i+1}`);
    const boxes = assignBoxes(players);
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].players.length, 5);
    assert.equal(boxes[1].players.length, 5);
  });

  test('9 players → one box of 4, one box of 5', () => {
    const players = Array.from({length: 9}, (_, i) => `P${i+1}`);
    const boxes = assignBoxes(players);
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].players.length, 4);
    assert.equal(boxes[1].players.length, 5);
  });

  test('4 players → single box of 4', () => {
    const boxes = assignBoxes(['A','B','C','D']);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].players.length, 4);
  });

  test('5 players → single box of 5', () => {
    const boxes = assignBoxes(['A','B','C','D','E']);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].players.length, 5);
  });

  test('15 players → three boxes of 5', () => {
    const players = Array.from({length: 15}, (_, i) => `P${i+1}`);
    const boxes = assignBoxes(players);
    assert.equal(boxes.length, 3);
    boxes.forEach(b => assert.equal(b.players.length, 5));
  });

});

// ---------------------------------------------------------------------------
// applyLeaderboardUpdate — full integration: standings → new leaderboard
// ---------------------------------------------------------------------------

describe('applyLeaderboardUpdate', () => {

  // Build a box where we fully control the result via match sets.
  // To make player X finish 1st, give them a match win against someone, etc.
  // Simplest approach: create boxes with no matches and inject finalPlacings-like
  // data by manually arranging the leaderboard so that the seeding ORDER equals
  // the desired result order (all 0-0 ties, leaderboard tiebreak applies).
  // That way the player seeded first always "wins" the tiebreak.

  test('two boxes of 4, no upsets — normal 2-up 2-down', () => {
    // Leaderboard: [A, B, C, D, E, F, G, H, ...rest]
    // Box 1 players: A,B,C,D (all play, no match data → tiebreak = leaderboard order)
    // Box 2 players: E,F,G,H
    // Expected result order: B1=[A,B,C,D], B2=[E,F,G,H]
    // Expected new order for slots 0-7: [A, B, E, F, C, D, G, H]
    const lb = ['A','B','C','D','E','F','G','H','I','J'];
    const box1 = { players: ['A','B','C','D'], matches: [] };
    const box2 = { players: ['E','F','G','H'], matches: [] };
    const result = applyLeaderboardUpdate([box1, box2], lb);
    // Slots 0-7 only; rest unchanged
    assert.deepEqual(result.slice(0, 8), ['A','B','E','F','C','D','G','H']);
    assert.deepEqual(result.slice(8), ['I','J']); // non-attendees unchanged
  });

  test('two boxes of 5, no upsets — 2-up 2-down with 1 neutral each', () => {
    // Leaderboard slots 0-9: P1..P10
    // Box 1: [P1..P5], Box 2: [P6..P10] — seeding order = result order (no match data)
    // Expected slot fill: [P1,P2,P3, P6,P7, P4,P5, P8, P9,P10]
    const lb = Array.from({length: 12}, (_, i) => `P${i+1}`);
    const box1 = { players: ['P1','P2','P3','P4','P5'], matches: [] };
    const box2 = { players: ['P6','P7','P8','P9','P10'], matches: [] };
    const result = applyLeaderboardUpdate([box1, box2], lb);
    assert.deepEqual(result.slice(0, 10), ['P1','P2','P3','P6','P7','P4','P5','P8','P9','P10']);
    assert.deepEqual(result.slice(10), ['P11','P12']); // non-attendees unchanged
  });

  test('non-attending players keep their absolute leaderboard positions', () => {
    // Only P3, P5, P7, P9 attend (every other player skips).
    // They form one box-of-4 at slots [2, 4, 6, 8].
    // The best finisher gets slot 2; 2nd gets slot 4; etc.
    // Slots 0,1,3,5,7 must be unchanged.
    const lb = Array.from({length: 10}, (_, i) => `P${i+1}`);
    const box1 = { players: ['P3','P5','P7','P9'], matches: [] };
    const result = applyLeaderboardUpdate([box1], lb);
    // Non-attendees at their exact original slots
    assert.equal(result[0], 'P1');
    assert.equal(result[1], 'P2');
    assert.equal(result[3], 'P4');
    assert.equal(result[5], 'P6');
    assert.equal(result[7], 'P8');
    assert.equal(result[9], 'P10');
    // Attendee slots 2,4,6,8 are filled (in some new order)
    const attendeeSlots = [result[2], result[4], result[6], result[8]];
    assert.deepEqual([...attendeeSlots].sort(), ['P3','P5','P7','P9'].sort());
  });

  test('single-box session — no movement (no adjacent box)', () => {
    // With one box, buildAttendeeOrder returns unchanged order.
    const lb = ['A','B','C','D','X','Y'];
    const box1 = { players: ['A','B','C','D'], matches: [] };
    const result = applyLeaderboardUpdate([box1], lb);
    assert.deepEqual(result, lb); // nothing changes
  });

});
