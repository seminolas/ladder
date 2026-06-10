// Parses the club leaderboard CSV.
// Detects player rows by: col A is a positive integer, col B is a non-empty string.
// Handles any number of header rows and any delimiter (comma or tab).
// Returns an array of player names in leaderboard order.
function parseLeaderboardCSV(text) {
  const lines = text.split(/\r?\n/);
  const players = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // Try tab first, then comma
    const cols = line.includes('\t')
      ? line.split('\t').map(c => c.trim().replace(/^"|"$/g, ''))
      : line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));

    const posCol = cols[0];
    const nameCol = cols[1];

    if (!nameCol || !nameCol.trim()) continue;

    const pos = parseInt(posCol, 10);
    if (!Number.isInteger(pos) || pos <= 0) continue;

    const name = nameCol.trim();
    if (name) players.push({ pos, name });
  }

  // Sort by position in case rows are out of order
  players.sort((a, b) => a.pos - b.pos);
  return players.map(p => p.name);
}
