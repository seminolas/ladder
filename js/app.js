function appData() {
  return {
    // ── State ──────────────────────────────────────────────────────────────
    view: 'home',          // 'setup' | 'home' | 'session'
    sessionTab: 1,         // 1=Attendance, 2=Boxes&Results, 3=Leaderboard
    loading: false,
    error: null,
    toast: null,
    toastTimer: null,

    // GitHub config
    cfg: { owner: '', repo: '', pat: '' },
    branch: null,

    // Leaderboard
    leaderboard: [],
    leaderboardSha: null,

    // Sessions list (array of date strings, newest first)
    sessionDates: [],
    mostRecentSessionStatus: null,

    // Active session
    session: null,
    sessionSha: null,

    // UI helpers
    attendanceSearch: '',
    highlightIdx: -1,
    addPlayerName: '',
    addPlayerPos: null,
    showAddPlayer: false,
    _saveTimer: null,

    // ── Init ───────────────────────────────────────────────────────────────
    async init() {
      this.cfg = { ...{ owner: '', repo: '', branch: 'main', pat: '' }, ...Storage.getConfig() };

      if (!this.cfg.owner || !this.cfg.repo) {
        this.view = 'setup';
        return;
      }

      this.branch = await Storage.getBranch();
      await this.loadHome();

      // Handle hash routing
      window.addEventListener('hashchange', () => this.route());
      this.route();
    },

    async route() {
      const hash = location.hash.replace('#', '') || '/';
      const m = hash.match(/^\/session\/(\d{4}-\d{2}-\d{2})/);
      if (m) {
        await this.openSession(m[1]);
      } else {
        this.view = 'home';
      }
    },

    // ── Config ─────────────────────────────────────────────────────────────
    async saveConfig() {
      Storage.saveConfig(this.cfg);
      this.view = 'home';
      await this.loadHome();
    },

    // ── Home ───────────────────────────────────────────────────────────────
    async loadHome() {
      this.loading = true;
      this.error = null;
      try {
        const lb = await Storage.getLeaderboard();
        if (lb) {
          this.leaderboard = lb.content.players;
          this.leaderboardSha = lb.sha;
        }
        this.sessionDates = await Storage.listSessions();
        if (this.sessionDates.length > 0) {
          const newest = this.sessionDates[0];
          if (this.session?.date === newest) {
            this.mostRecentSessionStatus = this.session.status;
          } else {
            const recent = await Storage.getSession(newest);
            this.mostRecentSessionStatus = recent?.content?.status ?? null;
          }
        } else {
          this.mostRecentSessionStatus = null;
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    get mostRecentSession() {
      return this.sessionDates[0] || null;
    },

    get isStaging() {
      return this.branch === 'staging';
    },

    // ── Staging reset ──────────────────────────────────────────────────────
    async resetStagingData() {
      if (!confirm('Delete all session files from staging? The leaderboard will be kept.')) return;
      this.loading = true;
      try {
        const files = await Storage.listSessionFiles();
        for (const f of files) {
          await Storage.deleteFile(f.path, f.sha);
        }
        this.sessionDates = [];
        this.mostRecentSessionStatus = null;
        this.session = null;
        this.sessionSha = null;
        this.view = 'home';
        location.hash = '/';
        this.showToast(`Cleared ${files.length} session(s). Leaderboard kept.`);
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    // ── CSV Import ─────────────────────────────────────────────────────────
    async importCSV(event) {
      const file = event.target.files[0];
      if (!file) return;

      // Block import while a session is in edit mode
      if (this.session && this.session.status !== 'closed') {
        this.showToast('Finish the current session before importing a new leaderboard.', 'error');
        event.target.value = '';
        return;
      }

      const text = await file.text();
      const players = parseLeaderboardCSV(text);
      if (players.length === 0) {
        this.showToast('No player rows found in CSV.', 'error');
        return;
      }

      if (!confirm(`Import ${players.length} players and overwrite the current leaderboard?`)) {
        event.target.value = '';
        return;
      }

      this.loading = true;
      try {
        this.leaderboardSha = await Storage.saveLeaderboard(players, this.leaderboardSha);
        this.leaderboard = players;
        this.showToast(`Imported ${players.length} players.`);
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
        event.target.value = '';
      }
    },

    // ── Session management ─────────────────────────────────────────────────
    defaultSessionDate() {
      return nextTuesday();
    },

    async startSession(date) {
      if (!date) return;
      if (this.sessionDates.includes(date)) {
        await this.openSession(date);
        return;
      }

      const newSession = {
        date,
        status: 'attendance',
        attendees: [],
        boxes: [],
        leaderboardBefore: [...this.leaderboard],
        leaderboardAfter: null,
      };

      this.loading = true;
      try {
        this.sessionSha = await Storage.saveSession(date, newSession, null);
        this.session = newSession;
        this.sessionDates = [date, ...this.sessionDates.filter(d => d !== date)];
        this.sessionTab = 1;
        this.view = 'session';
        location.hash = `/session/${date}`;
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    async openSession(date) {
      this.loading = true;
      try {
        const result = await Storage.getSession(date);
        if (!result) {
          this.showToast('Session not found.', 'error');
          return;
        }
        this.session = result.content;
        this.sessionSha = result.sha;
        this.mostRecentSessionStatus = result.content.status;
        this.sessionTab = 1;
        this.view = 'session';

        // Also ensure leaderboard is loaded
        if (this.leaderboard.length === 0) {
          const lb = await Storage.getLeaderboard();
          if (lb) { this.leaderboard = lb.content.players; this.leaderboardSha = lb.sha; }
        }
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    async saveSession() {
      try {
        this.sessionSha = await Storage.saveSession(this.session.date, this.session, this.sessionSha);
      } catch (e) {
        this.showToast('Save failed: ' + e.message, 'error');
        throw e;
      }
    },

    // Debounced save — batches rapid UI changes into one write.
    // Use this for attendance toggles and score entry; use saveSession() directly
    // for intentional actions (assign boxes, close session, etc).
    scheduleSave() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.saveSession(), 800);
    },

    // ── Attendance ─────────────────────────────────────────────────────────
    get attendanceLeaderboard() {
      // In edit mode show leaderboardBefore, otherwise current leaderboard
      const base = (this.session && this.session.status !== 'attendance' && this.session.leaderboardBefore)
        ? this.session.leaderboardBefore
        : this.leaderboard;
      return base;
    },

    get filteredPlayers() {
      const q = this.attendanceSearch.trim().toLowerCase();
      const lb = this.attendanceLeaderboard;
      if (!q) return lb.map((name, i) => ({ name, rank: i + 1 }));
      return lb
        .map((name, i) => ({ name, rank: i + 1 }))
        .filter(p => p.name.toLowerCase().includes(q));
    },

    get searchHasNoMatch() {
      const q = this.attendanceSearch.trim().toLowerCase();
      return q.length >= 2 && this.filteredPlayers.length === 0;
    },

    isAttending(name) {
      return this.session?.attendees.includes(name) ?? false;
    },

    async toggleAttendance(name) {
      if (!this.session || this.session.status === 'in_progress' || this.session.status === 'closed') return;

      const idx = this.session.attendees.indexOf(name);
      if (idx === -1) {
        this.session.attendees.push(name);
      } else {
        this.session.attendees.splice(idx, 1);
      }

      // If boxes were assigned, warn and clear them
      if (this.session.status === 'boxes_assigned' && this.session.boxes.length > 0) {
        if (!confirm('Attendance changed — this will clear the current box assignments. Continue?')) {
          // Revert
          if (idx === -1) this.session.attendees.pop();
          else this.session.attendees.splice(idx, 0, name);
          return;
        }
        this.session.boxes = [];
        this.session.status = 'attendance';
      }

      this.scheduleSave();
    },

    get attendingCount() {
      return this.session?.attendees.length ?? 0;
    },

    // ── Search keyboard navigation ─────────────────────────────────────────
    onSearchInput() {
      this.highlightIdx = this.attendanceSearch.trim() ? 0 : -1;
    },

    attendanceKeydown(e) {
      if (this.showAddPlayer) return;
      const players = this.filteredPlayers;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!players.length) return;
        this.highlightIdx = this.highlightIdx < players.length - 1 ? this.highlightIdx + 1 : 0;
        this._scrollHighlighted();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!players.length) return;
        this.highlightIdx = this.highlightIdx > 0 ? this.highlightIdx - 1 : players.length - 1;
        this._scrollHighlighted();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = this.highlightIdx >= 0 ? this.highlightIdx : 0;
        if (players[idx]) {
          this.toggleAttendance(players[idx].name);
          this.attendanceSearch = '';
          this.highlightIdx = -1;
        }
      } else if (e.key === 'Escape') {
        this.attendanceSearch = '';
        this.highlightIdx = -1;
      }
    },

    _scrollHighlighted() {
      this.$nextTick(() => {
        document.querySelector('.player-row-highlighted')?.scrollIntoView({ block: 'nearest' });
      });
    },

    clearSearch() {
      this.attendanceSearch = '';
      this.highlightIdx = -1;
    },

    // ── Add new player ─────────────────────────────────────────────────────
    prepareAddPlayer() {
      this.addPlayerName = this.attendanceSearch.trim();
      this.addPlayerPos = this.leaderboard.length + 1;
      this.showAddPlayer = true;
    },

    async confirmAddPlayer() {
      const name = this.addPlayerName.trim();
      if (!name) return;

      const pos = parseInt(this.addPlayerPos, 10);
      const insertIdx = Math.max(0, Math.min(pos - 1, this.leaderboard.length));

      // Insert into leaderboard
      const newLeaderboard = [...this.leaderboard];
      newLeaderboard.splice(insertIdx, 0, name);

      // Update session's leaderboardBefore for pre-game phases
      if (this.session && this.session.status !== 'in_progress' && this.session.status !== 'closed') {
        this.session.leaderboardBefore.splice(insertIdx, 0, name);
      }

      this.loading = true;
      try {
        this.leaderboardSha = await Storage.saveLeaderboard(newLeaderboard, this.leaderboardSha);
        this.leaderboard = newLeaderboard;

        // Auto-mark as attending
        if (this.session && !this.session.attendees.includes(name)) {
          this.session.attendees.push(name);
          await this.saveSession();
        }

        this.showAddPlayer = false;
        this.attendanceSearch = '';
        this.showToast(`Added ${name} at position ${insertIdx + 1}.`);
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    // ── Box assignment ─────────────────────────────────────────────────────
    async assignBoxes() {
      if (!this.session || this.attendingCount < 4) return;

      // Sort attendees by leaderboard position
      const lb = this.session.leaderboardBefore;
      const sorted = [...this.session.attendees].sort((a, b) => {
        const ai = lb.indexOf(a), bi = lb.indexOf(b);
        const a2 = ai === -1 ? 9999 : ai;
        const b2 = bi === -1 ? 9999 : bi;
        return a2 - b2;
      });

      this.session.boxes = assignBoxes(sorted);
      this.session.status = 'boxes_assigned';

      await this.saveSession();
      this.sessionTab = 2;
    },

    // ── Score entry ────────────────────────────────────────────────────────
    // Returns label like "Rory & Shivam"
    pairLabel(box, pairIndices) {
      return pairIndices.map(i => box.players[i].split(' ')[0]).join(' & ');
    },

    // First alphabetic word from a player name, stripping leading/trailing stars
    firstName(name) {
      const clean = name.replace(/^\*+\s*|\s*\*+$/g, '');
      return clean.match(/[a-zA-ZÀ-ÖØ-öø-ÿ]+/)?.[0] ?? clean.trim();
    },

    isSitout(boxIndex, matchIndex, playerIndex) {
      const box = this.session.boxes[boxIndex];
      if (box.players.length !== 5) return false;
      return SITOUT_5[matchIndex] === playerIndex;
    },

    setScore(boxIdx, matchIdx, setIdx, side, value) {
      if (this.session.status === 'closed') return;
      const match = this.session.boxes[boxIdx].matches[matchIdx];

      // Initialise set if needed
      while (match.sets.length <= setIdx) match.sets.push(['', '']);
      match.sets[setIdx][side] = value === '' ? '' : parseInt(value, 10) || 0;

      // Remove trailing empty sets
      while (match.sets.length > 0) {
        const last = match.sets[match.sets.length - 1];
        if (last[0] === '' && last[1] === '') match.sets.pop();
        else break;
      }

      // Transition to in_progress on first score entry
      if (this.session.status === 'boxes_assigned') {
        this.session.status = 'in_progress';
      }
    },

    saveScores() {
      this.scheduleSave();
    },

    getBoxStandings(boxIdx) {
      const box = this.session.boxes[boxIdx];
      return computeBoxStandings(box, this.session.leaderboardBefore);
    },

    get allScoresComplete() {
      if (!this.session?.boxes?.length) return false;
      return allScoresComplete(this.session.boxes);
    },

    // ── Close session ──────────────────────────────────────────────────────
    async closeSession() {
      if (!this.allScoresComplete) return;
      if (!confirm('Close this session and update the leaderboard?')) return;

      const newLeaderboard = applyLeaderboardUpdate(this.session.boxes, this.session.leaderboardBefore);
      this.session.leaderboardAfter = newLeaderboard;
      this.session.status = 'closed';

      this.loading = true;
      try {
        await this.saveSession();
        this.leaderboardSha = await Storage.saveLeaderboard(newLeaderboard, this.leaderboardSha);
        this.leaderboard = newLeaderboard;
        this.mostRecentSessionStatus = 'closed';
        this.sessionTab = 3;
        this.showToast('Session closed. Leaderboard updated.');
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    // ── Edit last closed session ───────────────────────────────────────────
    get canEditSession() {
      if (!this.session || this.session.status !== 'closed') return false;
      return this.session.date === this.sessionDates[0];
    },

    async enableEditing() {
      if (!confirm('Re-open this session for editing?\n\nThe live leaderboard will only be updated when you save and close again.')) return;
      // Snapshot current closed state so we can discard later
      this.session._editSnapshot = {
        boxes: JSON.parse(JSON.stringify(this.session.boxes)),
        leaderboardAfter: this.session.leaderboardAfter ? [...this.session.leaderboardAfter] : null,
      };
      this.session.status = 'in_progress';
      await this.saveSession();
    },

    async closeWithDiscard() {
      if (!confirm('Discard all changes and restore the original results?')) return;
      this.loading = true;
      try {
        const snap = this.session._editSnapshot;
        if (snap) {
          this.session.boxes = snap.boxes;
          this.session.leaderboardAfter = snap.leaderboardAfter;
        }
        this.session.status = 'closed';
        delete this.session._editSnapshot;
        await this.saveSession();
        this.showToast('Changes discarded.');
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    async closeSessionWithSave() {
      if (!confirm('Save changes and update the leaderboard?')) return;

      const newLeaderboard = applyLeaderboardUpdate(this.session.boxes, this.session.leaderboardBefore);
      this.session.leaderboardAfter = newLeaderboard;
      this.session.status = 'closed';

      this.loading = true;
      try {
        await this.saveSession();
        this.leaderboardSha = await Storage.saveLeaderboard(newLeaderboard, this.leaderboardSha);
        this.leaderboard = newLeaderboard;
        this.sessionTab = 3;
        this.showToast('Session saved. Leaderboard updated.');
      } catch (e) {
        this.showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    // ── WhatsApp share ────────────────────────────────────────────────────
    shareOnWhatsApp() {
      const { owner, repo, branch } = Storage.getConfig();
      const base = `https://${owner}.github.io/${repo}`;
      const date = this.session.date;
      const label = formatDate(date);
      const msg = `🏸 ${label} — Results: ${base}/#/session/${date}/results | Leaderboard: ${base}/#/leaderboard`;
      window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    },

    // ── Leaderboard delta ─────────────────────────────────────────────────
    rankDelta(name) {
      if (!this.session?.leaderboardBefore || !this.session?.leaderboardAfter) return 0;
      const before = this.session.leaderboardBefore.indexOf(name) + 1;
      const after = this.session.leaderboardAfter.indexOf(name) + 1;
      if (before === 0 || after === 0) return 0;
      return before - after; // positive = improved
    },

    deltaLabel(name) {
      const d = this.rankDelta(name);
      if (d > 0) return `↑${d}`;
      if (d < 0) return `↓${Math.abs(d)}`;
      return '→';
    },

    deltaClass(name) {
      const d = this.rankDelta(name);
      if (d > 0) return 'text-green-600 font-semibold';
      if (d < 0) return 'text-red-500 font-semibold';
      return 'text-gray-400';
    },

    // ── Print ─────────────────────────────────────────────────────────────
    printBoxes() {
      window.print();
    },

    // ── Toast ─────────────────────────────────────────────────────────────
    showToast(msg, type = 'success') {
      this.toast = { msg, type };
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast = null; }, 3500);
    },
  };
}
