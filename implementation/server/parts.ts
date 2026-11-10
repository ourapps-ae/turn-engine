// The interfaces the turn engine drives or composes, as it needs them. Each is provided by another
// component (see interfaces/required-*.json); state values are opaque to the engine and must be
// JSON-serialisable. Operations are pure: they return new state and never change their input.

export type Rng = () => number;

// ---- game-rules: one round of a game, as a state machine the engine can drive ----

export type RoundPlayer = { id: string; seat: number };
// Codes a game may refuse a move with. A code outside this list (and outside the engine's own
// ErrorCode set) reaches the client as notAllowed.
export type MoveCode = "badRequest" | "notAllowed" | "badAmount" | "notYourTurn" | "wrongPhase" | "notEnoughPlayers" | "unknownPlayer";
export type RoundPhase = {
  // acting: one player is to move; auto: the table advances by itself after autoDelayMs; over: finished.
  stage: "acting" | "auto" | "over";
  actorId: string | null;
  // acting: how long the table settles (deal, last move) before the actor's countdown starts.
  // Start from pacing.settleMs and add any time the game needs (for example to deal cards).
  settleMs: number;
  // auto: how long until the next step; measured from the previous step when steps follow each other.
  autoDelayMs: number | null;
  // What the table is settling on, and who moved last, for clients to animate.
  event: string | null;
  lastActorId: string | null;
};
export type RoundOutcome = {
  holdMs: number;
  voided: boolean;
  // Shown to clients as lastResult.
  result: unknown;
  // Merged into the round history entry {no, level, voided, ...historyEntry}.
  historyEntry: Record<string, unknown>;
};
export type HiddenRecord = {
  ownerId: string | null;
  open: Record<string, unknown>;
  hidden: Record<string, unknown>;
  revealed: Record<string, true | number[]>;
};
export type Moved = { ok: true; round: unknown; ledger: unknown } | { ok: false; code: MoveCode };

export type GameRules = {
  // Option names a client may switch on and off (for example "odds"); passed back to publicView.
  optionNames: string[];
  newRound(input: { no: number; level: number; players: RoundPlayer[]; carry: unknown | null }, ledger: unknown, rng: Rng): { round: unknown; ledger: unknown; carry: unknown };
  phase(round: unknown, pacing: { settleMs: number }): RoundPhase;
  parseMove(input: unknown): { ok: true; move: unknown; needsTurn: boolean } | { ok: false };
  act(round: unknown, ledger: unknown, playerId: string, move: unknown, context: { auto: boolean }): Moved;
  defaultMove(round: unknown, playerId: string): unknown;
  step(round: unknown, ledger: unknown): { round: unknown; ledger: unknown };
  outcome(round: unknown): RoundOutcome | null;
  voidRound(round: unknown, ledger: unknown): { round: unknown; ledger: unknown; outcome: RoundOutcome };
  observation(round: unknown, playerId: string): unknown;
  records(round: unknown): HiddenRecord[];
  // The game's own view of the round for one viewer (null is a display): the public facts plus
  // anything viewer-specific (such as odds when options asks for them). Hidden records are not
  // part of it; they come from records() through private-views.
  publicView(round: unknown, viewerId: string | null, options: Record<string, boolean>): unknown;
  legal(round: unknown, viewerId: string, context: { paused: boolean }): unknown;
  prompt(round: unknown, viewerId: string | null): { key: string; args: (string | number)[]; text: string } | null;
};

// ---- seating ----

export type Seat = { id: string; name: string; seat: number; computer: boolean };
export type SeatingOutcome = { ok: true; state: any } | { ok: false; code: string };
export type SeatingApi = {
  create(): any;
  validName(name: unknown): boolean;
  list(state: any): Seat[];
  find(state: any, id: string): Seat | undefined;
  count(state: any): number;
  people(state: any): Seat[];
  isFull(state: any): boolean;
  join(state: any, id: string, name: string, options?: { computer?: boolean }): SeatingOutcome;
  setHost(state: any, id: string | null): any;
  hostOf(state: any): string | null;
  isEnough(state: any): boolean;
  minimumPlayers(): number;
  leave(state: any, id: string): any;
  leaveRunning(state: any, id: string): any;
  mayReturn(state: any, id: string): boolean;
  returned(state: any, id: string): any;
  remove(state: any, byId: string, targetId: string): SeatingOutcome;
  canStart(state: any, byId: string): SeatingOutcome;
  canAddComputer(state: any, byId: string): SeatingOutcome;
  assign(state: any, rng: Rng): any;
  retain(state: any, keep: (seat: Seat) => boolean): any;
  compact(state: any): any;
};

// ---- game-clock ----

export type ClockApi = {
  create(now: number): any;
  advance(clock: any, now: number, runs: { action: boolean; level: boolean }): any;
  reset(clock: any, now: number): any;
  elapsed(clock: any, which: "action" | "level"): number;
  wallAt(clock: any, which: "action" | "level", targetMs: number): number;
};

// ---- private-views ----

export type PrivateViewsApi = {
  redact(viewerId: string | null, records: HiddenRecord[]): Record<string, unknown>[];
};

// ---- presence ----

export type Hold = "look" | "learn";
export type PresenceApi = {
  create(): any;
  register(state: any, id: string, now: number, kind: "person" | "computer"): any;
  unregister(state: any, id: string): any;
  restart(state: any, keepIds: readonly string[]): any;
  seen(state: any, id: string, now: number): any;
  setLive(state: any, id: string, live: boolean, now: number): any;
  away(state: any, id: string): any;
  sitOut(state: any, id: string): any;
  returned(state: any, id: string, now: number): any;
  leftGame(state: any, id: string): any;
  recordMiss(state: any, id: string): any;
  isConnected(state: any, id: string): boolean;
  isLive(state: any, id: string): boolean;
  isSittingOut(state: any, id: string): boolean;
  misses(state: any, id: string): number;
  lastSeen(state: any, id: string): number;
  refresh(state: any, now: number, context: { hostId: string | null; running: boolean; roundOver: boolean; activeIds: readonly string[] }): any;
  setManualPause(state: any, on: boolean, now: number): any;
  setHold(state: any, id: string, kind: Hold | null, context: { running: boolean; roundOver: boolean }): any;
  isPaused(state: any): boolean;
  pauseReasons(state: any): string[];
  isManualPause(state: any): boolean;
  pausedSince(state: any): number | null;
  isHeld(state: any): boolean;
  holds(state: any): { playerId: string; kind: Hold }[];
  nextWake(state: any): number | null;
};

// ---- tournament ----

export type TournamentApi = {
  create(): any;
  start(seats: any): any;
  activeIds(t: any): string[];
  isActive(t: any, id: string): boolean;
  balance(t: any, id: string): number;
  rebuysUsed(t: any, id: string): number;
  place(t: any, id: string): number | null;
  ledger(t: any): unknown;
  withLedger(t: any, ledger: unknown): any;
  levelAt(levelClockMs: number): number;
  clockInfo(levelClockMs: number): unknown;
  rebuyStack(): number;
  roundStarted(t: any): any;
  roundSettled(t: any, input: { level: number; actionMs: number; seats: any; computerDelayMs: number }): any;
  offers(t: any): { playerId: string; deadline: number; autoAt: number | null }[];
  hasOffers(t: any): boolean;
  // False while rebuy offers are open: the level clock stands still (runs.level of game-clock advance).
  levelClockRuns(t: any): boolean;
  offerFor(t: any, id: string): { playerId: string; deadline: number } | undefined;
  dueOffer(t: any, actionMs: number, seats: any): { playerId: string; accept: boolean } | null;
  nextOfferDue(t: any, seats: any): number | null;
  resolve(t: any, id: string, accept: boolean): { ok: true; state: any } | { ok: false; code: string };
  conclude(t: any, seats: any): { state: any; outcome: "continue" | "completed"; winnerId: string | null };
  cancel(t: any): any;
  winner(t: any): string | null;
};

// ---- computer-players ----

export type ComputersApi = {
  create(): any;
  forget(): any;
  add(seats: any, byId: string): { ok: true; state: any; name: string } | { ok: false; code: string };
  idFor(name: string): string;
  fill(seats: any): { state: any; added: string[] };
  actsFor(seats: any, player: { id: string; connected: boolean; sittingOut: boolean }): boolean;
  moveDeadline(clock: any, settleUntilMs: number, rng: Rng): number;
  isDue(clock: any, deadlineMs: number): boolean;
  rebuyDelayMs(): number;
  choose(state: any, observation: unknown, playerId: string, rng: Rng): { move: unknown | null; state: any };
  observe(state: any, observation: unknown, playerId: string, move: unknown): any;
};

// ---- round-history ----

export type HistoryApi = {
  create(): any;
  push(history: any, entry: Record<string, unknown>): any;
  list(history: any): Record<string, unknown>[];
};

// ---- rules-settings ----

export type RulesSettingsApi = { value(path: string): unknown };

export type Parts = {
  rules: GameRules;
  seating: SeatingApi;
  clock: ClockApi;
  views: PrivateViewsApi;
  presence: PresenceApi;
  tournament: TournamentApi;
  // Optional: without it nobody plays for a computer, addBot is refused and no seat is filled.
  computers?: ComputersApi;
  history: HistoryApi;
  settings: RulesSettingsApi;
};
