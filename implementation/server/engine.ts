// The game-independent turn engine: lifecycle (lobby, started, round cycle, end), checked actions
// with error codes, turn order, and the scheduled steps (advance, due moves, nextWake).
// It owns no game rules, seats, clocks, presence, chips or tournament logic: those are injected
// through `Parts`, each holding its own slice of the state. Two clocks drive it (game-clock):
// the action clock runs whenever the table is not paused or held and times moves, automatic
// steps, result pauses and rebuy offers; the level clock also stops while rebuy offers are open.
import { noComputers } from "./no-computers.ts";
import type { Hold, HiddenRecord, Parts, Rng, RoundOutcome, Seat } from "./parts.ts";

export type Status = "lobby" | "running" | "completed" | "cancelled";
export const ERROR_CODES = ["badName", "roomFull", "badToken", "staleVersion", "badRequest", "notYourTurn", "wrongPhase", "notEnoughPlayers", "badAmount", "badTarget", "notAllowed", "paused", "unknownPlayer"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
// A code a part reports, as one of ours: anything we do not list is notAllowed.
export const asErrorCode = (code: unknown): ErrorCode => ((ERROR_CODES as readonly unknown[]).includes(code) ? (code as ErrorCode) : "notAllowed");
export type EngineAction =
  | { type: "start" | "addBot" | "leave" | "sitOut" | "return" | "pause" | "resume" | "cancel" | "newGame" }
  | { type: "kick"; playerId: string }
  | { type: "rebuy"; accept: boolean }
  | { type: "move"; move: unknown; needsTurn: boolean };
export type Deps = { rng: Rng; now: () => number };

export type EngineSettings = {
  // Seconds a person has to move; null reads rules-settings "timing.decision_seconds", then 30.
  decisionSeconds: number | null;
  // The table settles this long after a deal or a move before the countdown starts.
  settleMs: number;
  // An idle lobby or a finished table is emptied; a table paused with nobody connected is cancelled.
  staleMinutes: number;
  // Standings stay up this long after the game ends, then the room is a lobby again.
  standingsSeconds: number;
  // A lobby seat whose person has not been heard from this long is given up.
  lobbyDropSeconds: number;
};
export const DEFAULT_SETTINGS: EngineSettings = { decisionSeconds: null, settleMs: 4000, staleMinutes: 30, standingsSeconds: 20, lobbyDropSeconds: 60 };

export function checkSettings(input: Partial<EngineSettings> = {}): EngineSettings {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const whole = (n: unknown, min: number) => Number.isInteger(n) && (n as number) >= min;
  if (!(s.decisionSeconds === null || whole(s.decisionSeconds, 1)) || !whole(s.settleMs, 0) || !whole(s.staleMinutes, 1) || !whole(s.standingsSeconds, 1) || !whole(s.lobbyDropSeconds, 1)) {
    throw new Error("turn-engine: decisionSeconds (1 or more, or null), settleMs (0 or more), staleMinutes, standingsSeconds and lobbyDropSeconds (1 or more) must be whole numbers");
  }
  return s;
}

// When the actor's turn is timed and why.
export type Schedule = {
  actorId: string | null;
  // Action-clock times: the settle ends, the actor's move falls due, the next automatic step, the result pause ends.
  settleUntil: number | null;
  deadline: number | null;
  autoAt: number | null;
  overAt: number | null;
  event: string | null;
  lastActorId: string | null;
};
export type Slot = { no: number; level: number; round: unknown; stage: "acting" | "auto" | "over"; schedule: Schedule };
export type EngineState = {
  schema: 1;
  status: Status;
  gameNumber: number;
  seats: any;
  presence: any;
  clock: any;
  tournament: any;
  computers: any;
  history: any;
  roundNo: number;
  slot: Slot | null;
  carry: unknown | null;
  lastResult: unknown | null;
  lastActionAt: number;
  endedAt: number | null;
};
export type Result = { ok: true; game: EngineState } | { ok: false; code: ErrorCode };

export type Legal = {
  start: boolean; addBot: boolean; kick: boolean; leave: boolean; sitOut: boolean; return: boolean;
  rebuy: boolean; pause: boolean; resume: boolean; cancel: boolean; newGame: boolean;
  // The game's own legal moves for this viewer, from game-rules.
  game: unknown;
};
export type PlayerRow = {
  id: string; name: string; seat: number; isBot: boolean; isHost: boolean; stack: number; status: "in" | "out"; place: number | null;
  connected: boolean; sittingOut: boolean; rebuysUsed: number;
  // The game's record for this player as this viewer may see it (private-views).
  game: Record<string, unknown> | null;
};
export type RoundView = {
  no: number; level: number; stage: "acting" | "auto" | "over"; actorId: string | null;
  // Milliseconds left on a person's countdown (including nothing of the settle), the next automatic step or the result pause.
  remainingMs: number | null; settleMs: number | null; event: string | null; lastActorId: string | null;
};
export type View = {
  version: number; roomId: string; gameNumber: number; you: string; display: boolean;
  status: Status; phase: "lobby" | "acting" | "auto" | "over" | "offers" | "completed" | "cancelled";
  pauseReasons: string[]; holds: { playerId: string; kind: Hold }[]; hostId: string | null;
  players: PlayerRow[]; round: RoundView | null; game: unknown | null; lastResult: unknown | null;
  clock: unknown | null; rebuyOffers: { playerId: string; remainingMs: number }[]; winnerId: string | null;
  history: Record<string, unknown>[]; legal: Legal; prompt: string; promptKey: string; promptArgs: (string | number)[];
};

const NONE: Legal = { start: false, addBot: false, kick: false, leave: false, sitOut: false, return: false, rebuy: false, pause: false, resume: false, cancel: false, newGame: false, game: null };

export function createEngine(parts: Parts, input: Partial<EngineSettings> = {}) {
  const cfg = checkSettings(input);
  const { rules, seating, clock, views, presence, tournament, history, settings } = parts;
  const computers = parts.computers ?? noComputers;
  const staleMs = cfg.staleMinutes * 60_000;
  const standingsMs = cfg.standingsSeconds * 1000;
  const lobbyDropMs = cfg.lobbyDropSeconds * 1000;
  const decisionMs = () => {
    const fromRules = settings.value("timing.decision_seconds");
    return (cfg.decisionSeconds ?? (typeof fromRules === "number" && fromRules > 0 ? fromRules : 30)) * 1000;
  };
  const fail = (code: ErrorCode): Result => ({ ok: false, code });

  // ---- small readers over the composed state ----
  const actionMs = (g: EngineState) => clock.elapsed(g.clock, "action");
  const levelMs = (g: EngineState) => clock.elapsed(g.clock, "level");
  const isComputer = (g: EngineState, id: string) => seating.find(g.seats, id)?.computer === true;
  const paused = (g: EngineState) => presence.isPaused(g.presence);
  const betweenRounds = (g: EngineState) => g.status === "running" && (g.slot === null || g.slot.stage === "over");
  const presentFacts = (g: EngineState, id: string) => ({ id, connected: presence.isConnected(g.presence, id), sittingOut: presence.isSittingOut(g.presence, id) });
  const actsFor = (g: EngineState, id: string) => computers.actsFor(g.seats, presentFacts(g, id));
  const ended = (g: EngineState) => g.status === "completed" || g.status === "cancelled";

  function create(now: number): EngineState {
    return {
      schema: 1, status: "lobby", gameNumber: 0, seats: seating.create(), presence: presence.create(), clock: clock.create(now),
      tournament: tournament.create(), computers: computers.create(), history: history.create(), roundNo: 0, slot: null,
      carry: null, lastResult: null, lastActionAt: now, endedAt: null,
    };
  }

  // A fresh lobby in the same room: game number kept, nothing else.
  function resetLobby(g: EngineState, now: number): void {
    const n = g.gameNumber;
    Object.assign(g, create(now));
    g.gameNumber = n;
  }

  function validState(s: unknown): s is EngineState {
    const g = s as EngineState;
    return !!g && g.schema === 1 && ["lobby", "running", "completed", "cancelled"].includes(g.status) && Number.isFinite(g.gameNumber)
      && !!g.seats && !!g.presence && !!g.clock && !!g.tournament && !!g.computers && !!g.history && Number.isFinite(g.lastActionAt)
      && (g.slot === null || (typeof g.slot === "object" && !!g.slot.schedule && typeof g.slot.stage === "string"));
  }

  // ---- joining ----

  // Seat a new person; the caller has already handled rejoin by name.
  function join(game: EngineState, id: string, name: string, now: number): Result {
    if (!seating.validName(name)) return fail("badName");
    if (game.status !== "lobby") return fail("wrongPhase");
    const r = seating.join(game.seats, id, name);
    if (!r.ok) return fail(asErrorCode(r.code));
    const g = structuredClone(game);
    g.seats = r.state;
    g.presence = presence.register(g.presence, id, now, "person");
    g.lastActionAt = now;
    return { ok: true, game: g };
  }

  // ---- presence from the room ----

  // Presence operations return the same state object when nothing changed.
  const seen = (game: EngineState, id: string, now: number): EngineState => {
    if (!seating.find(game.seats, id)) return game;
    const next = presence.seen(game.presence, id, now);
    return next === game.presence ? game : { ...game, presence: next };
  };
  const setLive = (game: EngineState, id: string, live: boolean, now: number): EngineState => {
    const p = seating.find(game.seats, id);
    if (!p || p.computer || presence.isLive(game.presence, id) === live) return game;
    return { ...game, presence: presence.setLive(game.presence, id, live, now) };
  };
  const away = (game: EngineState, id: string): EngineState => {
    if (!seating.find(game.seats, id) || !presence.isConnected(game.presence, id)) return game;
    return { ...game, presence: presence.away(game.presence, id) };
  };
  const setHold = (game: EngineState, id: string, kind: Hold | null): EngineState => {
    const p = seating.find(game.seats, id);
    const current = presence.holds(game.presence).find((h) => h.playerId === id)?.kind ?? null;
    if (kind !== null && (!p || p.computer || game.status !== "running")) return game;
    if (kind === "look" && game.slot?.stage !== "over") return game;
    if (current === kind) return game;
    const next = presence.setHold(game.presence, id, kind, { running: game.status === "running", roundOver: game.slot?.stage === "over" });
    return next === game.presence ? game : { ...game, presence: next };
  };

  // ---- actions ----

  function apply(game: EngineState, playerId: string, action: EngineAction, deps: Deps): Result {
    const g = advance(game, deps).game;
    if (!seating.find(g.seats, playerId)) return fail("badToken");
    const r = step(g, playerId, action, deps);
    if (r.ok) {
      r.game.lastActionAt = deps.now();
      refresh(r.game, deps.now());
      runDue(r.game, deps);
      if (ended(r.game) && r.game.endedAt === null) r.game.endedAt = deps.now();
    }
    return r;
  }

  function step(g: EngineState, playerId: string, action: EngineAction, deps: Deps): Result {
    const now = deps.now();
    const me = seating.find(g.seats, playerId)!;
    switch (action.type) {
      case "start":
        return start(g, me, deps);
      case "addBot": {
        if (g.status !== "lobby") return fail("wrongPhase");
        const r = computers.add(g.seats, playerId);
        if (!r.ok) return fail(asErrorCode(r.code));
        g.seats = r.state;
        g.presence = presence.register(g.presence, computers.idFor(r.name), now, "computer");
        return { ok: true, game: g };
      }
      case "kick": {
        if (g.status !== "lobby") return fail("wrongPhase");
        const r = seating.remove(g.seats, playerId, action.playerId);
        if (!r.ok) return fail(asErrorCode(r.code));
        g.seats = r.state;
        g.presence = presence.unregister(g.presence, action.playerId);
        return { ok: true, game: g };
      }
      case "leave":
        return leave(g, me, now);
      case "sitOut":
        if (g.status !== "running" || !tournament.isActive(g.tournament, playerId)) return fail("wrongPhase");
        g.presence = presence.sitOut(g.presence, playerId);
        return { ok: true, game: g };
      case "return":
        if (g.status !== "running") return fail("wrongPhase");
        if (!seating.mayReturn(g.seats, playerId)) return fail("notAllowed");
        g.seats = seating.returned(g.seats, playerId);
        g.presence = presence.returned(g.presence, playerId, now);
        return { ok: true, game: g };
      case "move":
        return move(g, me, action, deps);
      case "rebuy":
        if (g.status !== "running") return fail("wrongPhase");
        if (!tournament.offerFor(g.tournament, playerId)) return fail("notAllowed");
        if (paused(g)) return fail("paused");
        resolveOffer(g, playerId, action.accept, deps);
        return { ok: true, game: g };
      case "pause":
      case "resume":
        if (g.status !== "running") return fail("wrongPhase");
        if (!seating.find(g.seats, playerId) || seating.hostOf(g.seats) !== playerId) return fail("notAllowed");
        if (!betweenRounds(g)) return fail("wrongPhase");
        g.presence = presence.setManualPause(g.presence, action.type === "pause", now);
        return { ok: true, game: g };
      case "cancel":
        if (g.status !== "running") return fail("wrongPhase");
        if (me.computer) return fail("notAllowed");
        doCancel(g);
        return { ok: true, game: g };
      case "newGame":
        if (!ended(g)) return fail("wrongPhase");
        if (me.computer) return fail("notAllowed");
        backToLobby(g, now);
        return { ok: true, game: g };
    }
  }

  function start(g: EngineState, me: Seat, deps: Deps): Result {
    if (g.status !== "lobby") return fail("wrongPhase");
    if (me.computer) return fail("notAllowed");
    const now = deps.now();
    const filled = computers.fill(g.seats);
    for (const name of filled.added) g.presence = presence.register(g.presence, computers.idFor(name), now, "computer");
    g.seats = filled.state;
    const ok = seating.canStart(g.seats, me.id);
    if (!ok.ok) return fail(asErrorCode(ok.code));
    g.seats = seating.setHost(seating.assign(g.seats, deps.rng), me.id);
    g.gameNumber += 1;
    g.status = "running";
    g.tournament = tournament.start(g.seats);
    g.presence = presence.restart(g.presence, seating.list(g.seats).map((s) => s.id));
    g.clock = clock.reset(g.clock, now);
    g.computers = computers.forget();
    g.history = history.create();
    g.roundNo = 0;
    g.slot = null;
    g.carry = null;
    g.lastResult = null;
    g.endedAt = null;
    startRound(g, deps);
    return { ok: true, game: g };
  }

  // In the lobby the seat is given up. In a game the person sits out and keeps stack, seat and
  // (with returnToStack) the right to return; a person who leaves counts as disconnected.
  function leave(g: EngineState, me: Seat, now: number): Result {
    if (g.status !== "running") {
      g.seats = seating.leave(g.seats, me.id);
      g.presence = presence.unregister(g.presence, me.id);
      if (seating.people(g.seats).length === 0) resetLobby(g, now);
      return { ok: true, game: g };
    }
    g.seats = seating.leaveRunning(g.seats, me.id);
    g.presence = presence.leftGame(g.presence, me.id);
    return { ok: true, game: g };
  }

  function move(g: EngineState, me: Seat, action: Extract<EngineAction, { type: "move" }>, deps: Deps): Result {
    const slot = g.slot;
    if (action.needsTurn) {
      if (g.status !== "running" || !slot || slot.stage !== "acting") return fail("wrongPhase");
      if (paused(g)) return fail("paused");
      if (slot.schedule.actorId !== me.id) return fail("notYourTurn");
    } else if ((g.status !== "running" && g.status !== "completed") || !slot) return fail("wrongPhase");
    const seenBefore = rules.observation(slot.round, me.id);
    const r = rules.act(slot.round, tournament.ledger(g.tournament), me.id, action.move, { auto: false });
    if (!r.ok) return fail(asErrorCode(r.code));
    slot.round = r.round;
    g.tournament = tournament.withLedger(g.tournament, r.ledger);
    g.computers = computers.observe(g.computers, seenBefore, me.id, action.move);
    if (action.needsTurn) syncPhase(g, deps, null);
    return { ok: true, game: g };
  }

  // Any person at the room may end the game, playing or not, host present or not, paused or not.
  function cancelByWatcher(game: EngineState, now: number): Result {
    if (game.status !== "running") return fail("wrongPhase");
    const g = structuredClone(game);
    doCancel(g);
    g.lastActionAt = now;
    g.endedAt = now;
    return { ok: true, game: g };
  }

  function doCancel(g: EngineState): void {
    const slot = g.slot;
    if (slot && slot.stage !== "over") {
      const v = rules.voidRound(slot.round, tournament.ledger(g.tournament));
      g.tournament = tournament.withLedger(g.tournament, v.ledger);
      record(g, slot, v.outcome);
    }
    g.slot = null;
    g.tournament = tournament.cancel(g.tournament);
    g.status = "cancelled";
  }

  function record(g: EngineState, slot: Slot, outcome: RoundOutcome): void {
    g.lastResult = outcome.result;
    g.history = history.push(g.history, { no: slot.no, level: slot.level, voided: outcome.voided, ...outcome.historyEntry });
  }

  // The room is free again: connected people and the computer players keep their places in a new
  // lobby; absent people are dropped.
  function backToLobby(g: EngineState, now: number): void {
    const keep = (s: Seat) => s.computer || presence.isConnected(g.presence, s.id);
    const kept = seating.retain(g.seats, keep);
    const ids = seating.list(kept).map((s) => s.id);
    const n = g.gameNumber;
    const presenceKept = presence.restart(g.presence, ids);
    Object.assign(g, create(now));
    g.gameNumber = n;
    if (seating.people(kept).length === 0) return;
    g.seats = kept;
    g.presence = presenceKept;
  }

  // ---- clocks, presence, pauses ----

  function tick(g: EngineState, now: number): void {
    const running = g.status === "running" && !paused(g) && !presence.isHeld(g.presence);
    g.clock = clock.advance(g.clock, now, { action: running, level: running && tournament.levelClockRuns(g.tournament) });
  }

  function refresh(g: EngineState, now: number): void {
    g.presence = presence.refresh(g.presence, now, {
      hostId: seating.hostOf(g.seats),
      running: g.status === "running",
      roundOver: g.slot?.stage === "over",
      activeIds: g.status === "running" ? tournament.activeIds(g.tournament) : [],
    });
  }

  // Bring the table up to date: clocks, presence, then everything that fell due. Computer moves
  // are not made here; the room asks `computerDue` and applies the move.
  function advance(game: EngineState, deps: Deps): { game: EngineState; changed: boolean } {
    const g = structuredClone(game);
    const now = deps.now();
    tick(g, now);
    refresh(g, now);
    runDue(g, deps);
    if (g.status === "running" && presence.pauseReasons(g.presence).includes("allOffline") && presence.pausedSince(g.presence) !== null && now - presence.pausedSince(g.presence)! >= staleMs) {
      doCancel(g);
      g.lastActionAt = now;
    }
    if (ended(g)) {
      g.endedAt = g.endedAt ?? now;
      if (now - g.endedAt >= standingsMs) backToLobby(g, now);
    }
    if (g.status === "lobby") dropAbsentFromLobby(g, now);
    if (g.status !== "running" && seating.count(g.seats) > 0 && now - g.lastActionAt >= staleMs) resetLobby(g, now);
    return { game: g, changed: visible(g) !== visible(game) };
  }

  function dropAbsentFromLobby(g: EngineState, now: number): void {
    const before = seating.count(g.seats);
    const kept = seating.retain(g.seats, (s) => s.computer || presence.isLive(g.presence, s.id) || now - presence.lastSeen(g.presence, s.id) <= lobbyDropMs);
    if (seating.people(kept).length === 0) {
      if (before > 0) {
        for (const s of seating.list(g.seats)) g.presence = presence.unregister(g.presence, s.id);
        g.seats = seating.create();
      }
      return;
    }
    if (seating.count(kept) !== before) {
      for (const s of seating.list(g.seats)) if (!seating.find(kept, s.id)) g.presence = presence.unregister(g.presence, s.id);
      g.seats = kept;
    }
  }

  // Everything but the clocks, which move with time without anyone needing to be told.
  const visible = (g: EngineState): string => JSON.stringify({ ...g, clock: null });

  function runDue(g: EngineState, deps: Deps): void {
    for (let i = 0; i < 200; i++) if (!dueStep(g, deps)) return;
  }

  // One due event; true when something happened.
  function dueStep(g: EngineState, deps: Deps): boolean {
    if (g.status !== "running" || paused(g)) return false;
    const now = actionMs(g);
    const offer = tournament.dueOffer(g.tournament, now, g.seats);
    if (offer) return resolveOffer(g, offer.playerId, offer.accept, deps);
    const slot = g.slot;
    if (!slot) {
      if (!tournament.hasOffers(g.tournament)) {
        afterOffers(g, deps);
        return true;
      }
      return false;
    }
    const sch = slot.schedule;
    if (slot.stage === "acting" && sch.actorId && sch.deadline !== null && now >= sch.deadline) {
      const id = sch.actorId;
      // Computers (and people they take over for) are moved by the room through computerDue.
      if (actsFor(g, id)) return false;
      const connected = presence.isConnected(g.presence, id);
      const sitting = presence.isSittingOut(g.presence, id);
      // Due to be skipped as absent, but back: a full countdown instead.
      if (connected && !sitting && sch.settleUntil !== null && sch.deadline <= sch.settleUntil) {
        sch.deadline = sch.settleUntil + decisionMs();
        return true;
      }
      if (!connected || sitting) g.presence = presence.recordMiss(g.presence, id);
      const r = rules.act(slot.round, tournament.ledger(g.tournament), id, rules.defaultMove(slot.round, id), { auto: true });
      if (!r.ok) throw new Error("turn-engine: the game's default move was refused: " + r.code);
      slot.round = r.round;
      g.tournament = tournament.withLedger(g.tournament, r.ledger);
      syncPhase(g, deps, null);
      return true;
    }
    if (slot.stage === "auto" && sch.autoAt !== null && now >= sch.autoAt) {
      const r = rules.step(slot.round, tournament.ledger(g.tournament));
      slot.round = r.round;
      g.tournament = tournament.withLedger(g.tournament, r.ledger);
      syncPhase(g, deps, sch.autoAt);
      return true;
    }
    if (slot.stage === "over" && sch.overAt !== null && now >= sch.overAt) {
      finishRound(g, deps);
      return true;
    }
    return false;
  }

  // The computer-side player whose move is due, if any.
  function computerDue(g: EngineState): string | null {
    const slot = g.slot;
    if (g.status !== "running" || paused(g) || !slot || slot.stage !== "acting" || !slot.schedule.actorId || slot.schedule.deadline === null) return null;
    const id = slot.schedule.actorId;
    return actsFor(g, id) && computers.isDue(g.clock, slot.schedule.deadline) ? id : null;
  }

  // Play the due computer-side move: the strategy's choice, else the game's default move.
  // `moved` is false when nobody was due.
  function computerMove(game: EngineState, deps: Deps): { game: EngineState; moved: boolean } {
    const id = computerDue(game);
    if (id === null) return { game, moved: false };
    const observation = rules.observation(game.slot!.round, id);
    const choice = computers.choose(game.computers, observation, id, deps.rng);
    const attempts = [choice.move, rules.defaultMove(game.slot!.round, id)].filter((m) => m !== null);
    for (const move of attempts) {
      const r = apply(game, id, { type: "move", move, needsTurn: true }, deps);
      if (r.ok) return { game: r.game, moved: true };
    }
    throw new Error("turn-engine: neither the strategy's move nor the game's default move was accepted for " + id);
  }

  // Wall time of the next thing the table must do by itself, or null.
  function nextWake(g: EngineState): number | null {
    if (g.status === "lobby") {
      if (seating.count(g.seats) === 0) return null;
      const drops = seating.people(g.seats).filter((p) => !presence.isLive(g.presence, p.id)).map((p) => presence.lastSeen(g.presence, p.id) + lobbyDropMs + 1);
      return Math.min(g.lastActionAt + staleMs, ...drops);
    }
    if (g.status !== "running") return g.endedAt !== null ? g.endedAt + standingsMs : null;
    const times: number[] = [];
    const silence = presence.nextWake(g.presence);
    if (silence !== null) times.push(silence);
    if (paused(g)) {
      const since = presence.pausedSince(g.presence);
      if (presence.pauseReasons(g.presence).includes("allOffline") && since !== null) times.push(since + staleMs);
    } else if (!presence.isHeld(g.presence)) {
      const wall = (t: number | null) => {
        if (t !== null) times.push(clock.wallAt(g.clock, "action", t));
      };
      const slot = g.slot;
      if (slot) {
        wall(slot.stage === "acting" ? slot.schedule.deadline : null);
        wall(slot.stage === "auto" ? slot.schedule.autoAt : null);
        wall(slot.stage === "over" ? slot.schedule.overAt : null);
      } else if (!tournament.hasOffers(g.tournament)) wall(actionMs(g));
      wall(tournament.nextOfferDue(g.tournament, g.seats));
    }
    return times.length ? Math.min(...times) : null;
  }

  // ---- rounds ----

  function startRound(g: EngineState, deps: Deps): void {
    const active = new Set(tournament.activeIds(g.tournament));
    const players = seating.list(g.seats).filter((s) => active.has(s.id)).map((s) => ({ id: s.id, seat: s.seat }));
    const level = tournament.levelAt(levelMs(g));
    const t = tournament.roundStarted(g.tournament);
    const no = g.roundNo + 1;
    const r = rules.newRound({ no, level, players, carry: g.carry }, tournament.ledger(t), deps.rng);
    g.tournament = tournament.withLedger(t, r.ledger);
    g.roundNo = no;
    g.carry = r.carry;
    g.slot = { no, level, round: r.round, stage: "acting", schedule: { actorId: null, settleUntil: null, deadline: null, autoAt: null, overAt: null, event: null, lastActorId: null } };
    syncPhase(g, deps, null);
  }

  // Read the round's phase and set the schedule. `autoBase` keeps the pace of automatic steps
  // when several fall due together.
  function syncPhase(g: EngineState, deps: Deps, autoBase: number | null): void {
    const slot = g.slot!;
    const ph = rules.phase(slot.round, { settleMs: cfg.settleMs });
    const sch = slot.schedule;
    const now = actionMs(g);
    sch.event = ph.event;
    sch.lastActorId = ph.lastActorId;
    sch.actorId = null;
    sch.deadline = null;
    sch.settleUntil = null;
    sch.autoAt = null;
    if (ph.stage === "acting") {
      const id = ph.actorId!;
      slot.stage = "acting";
      sch.actorId = id;
      sch.settleUntil = now + ph.settleMs;
      // A computer thinks a little longer; an absent person is acted for at the end of the settle;
      // a present person gets the full decision time from then.
      if (actsFor(g, id)) sch.deadline = computers.moveDeadline(g.clock, sch.settleUntil, deps.rng);
      else if (presence.isSittingOut(g.presence, id) || (!presence.isConnected(g.presence, id) && presence.misses(g.presence, id) > 0)) sch.deadline = sch.settleUntil;
      else sch.deadline = sch.settleUntil + decisionMs();
    } else if (ph.stage === "auto") {
      slot.stage = "auto";
      sch.autoAt = (autoBase ?? now) + (ph.autoDelayMs ?? 0);
    } else if (slot.stage !== "over") {
      const outcome = rules.outcome(slot.round);
      if (!outcome) throw new Error("turn-engine: the game reported the round over without an outcome");
      slot.stage = "over";
      sch.overAt = now + outcome.holdMs;
      record(g, slot, outcome);
    }
  }

  // The result pause is over: rebuy offers, then eliminations, winner or the next round.
  function finishRound(g: EngineState, deps: Deps): void {
    const slot = g.slot!;
    g.tournament = tournament.roundSettled(g.tournament, { level: slot.level, actionMs: actionMs(g), seats: g.seats, computerDelayMs: computers.rebuyDelayMs() });
    g.slot = null;
    if (!tournament.hasOffers(g.tournament)) afterOffers(g, deps);
  }

  function resolveOffer(g: EngineState, id: string, accept: boolean, deps: Deps): boolean {
    const r = tournament.resolve(g.tournament, id, accept);
    if (!r.ok) return false;
    g.tournament = r.state;
    if (!tournament.hasOffers(g.tournament)) afterOffers(g, deps);
    return true;
  }

  function afterOffers(g: EngineState, deps: Deps): void {
    const c = tournament.conclude(g.tournament, g.seats);
    g.tournament = c.state;
    if (c.outcome === "completed") {
      g.status = "completed";
      g.slot = null;
    } else startRound(g, deps);
  }

  // ---- views ----

  function legalFor(g: EngineState, meId: string | null): Legal {
    const me = meId === null ? undefined : seating.find(g.seats, meId);
    if (meId === null) return { ...NONE };
    if (!me) return { ...NONE, leave: true, cancel: g.status === "running" };
    const legal: Legal = { ...NONE };
    const human = !me.computer;
    if (g.status === "lobby") {
      legal.start = human && seating.isEnough(g.seats);
      legal.addBot = human && seating.canAddComputer(g.seats, me.id).ok && computers.add(g.seats, me.id).ok;
      legal.kick = human && seating.list(g.seats).some((s) => seating.remove(g.seats, me.id, s.id).ok);
      legal.leave = true;
      return legal;
    }
    if (ended(g)) {
      legal.leave = true;
      legal.newGame = human;
      return legal;
    }
    legal.leave = true;
    legal.cancel = human;
    if (tournament.isActive(g.tournament, me.id)) {
      const out = presence.isSittingOut(g.presence, me.id);
      legal.sitOut = !out;
      legal.return = out && seating.mayReturn(g.seats, me.id);
    }
    if (seating.hostOf(g.seats) === me.id && betweenRounds(g)) {
      const manual = presence.isManualPause(g.presence);
      legal.pause = !manual;
      legal.resume = manual;
    }
    if (tournament.offerFor(g.tournament, me.id) && !paused(g)) legal.rebuy = true;
    if (g.slot) legal.game = rules.legal(g.slot.round, me.id, { paused: paused(g) });
    return legal;
  }

  function phaseOf(g: EngineState): View["phase"] {
    if (g.status === "lobby") return "lobby";
    if (g.status !== "running") return g.status;
    if (tournament.hasOffers(g.tournament) || !g.slot) return "offers";
    return g.slot.stage;
  }

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function promptFor(g: EngineState, meId: string | null, legal: Legal): { key: string; args: (string | number)[]; text: string } {
    const display = meId === null;
    const me = display ? undefined : seating.find(g.seats, meId);
    const name = (id: string | null) => seating.find(g.seats, id ?? "")?.name ?? "";
    const p = (key: string, text: string, ...args: (string | number)[]) => ({ key, args, text });
    if (!me && !display) return p("watching", "You are watching this table.");
    const hostName = name(seating.hostOf(g.seats));
    switch (g.status) {
      case "lobby":
        if (!seating.isEnough(g.seats)) {
          // How many more people the game needs before it can start: one key for one more, another for several.
          const more = seating.minimumPlayers() - seating.count(g.seats);
          return more === 1 ? p("lobbyWaitingOne", "Waiting for 1 more player.", more) : p("lobbyWaiting", `Waiting for ${more} more players.`, more);
        }
        return p("lobbyReady", "Anyone can start the game.");
      case "completed": {
        const w = tournament.winner(g.tournament);
        return w ? p("champion", `${name(w)} wins the tournament.`, name(w)) : p("completedTie", "The tournament is over.");
      }
      case "cancelled":
        return p("cancelled", "The game was ended. No winner.");
    }
    const reasons = presence.pauseReasons(g.presence);
    if (reasons.includes("hostAbsent")) return p("pausedHost", `Paused: ${hostName} (host) is away.`, hostName);
    if (reasons.includes("allOffline")) return p("pausedOffline", "Paused: nobody in the game is connected.");
    if (reasons.includes("manual")) return p("pausedManual", `Paused by ${hostName}.`, hostName);
    if (legal.rebuy) return p("rebuyOffer", `Out of chips. Take your rebuy of ${tournament.rebuyStack()}?`, tournament.rebuyStack());
    if (tournament.hasOffers(g.tournament)) {
      const who = tournament.offers(g.tournament).map((o) => name(o.playerId)).join(", ");
      return p("rebuyWaiting", `Waiting for ${who} to decide on a rebuy.`, who);
    }
    const slot = g.slot;
    if (!slot) return p("dealing", "Dealing.");
    if (slot.stage !== "acting") {
      const fromRules = rules.prompt(slot.round, meId);
      if (fromRules) return fromRules;
      return p(slot.stage === "over" ? "roundOver" : "waiting", slot.stage === "over" ? "The round is over." : "Waiting.");
    }
    if (me && !tournament.isActive(g.tournament, me.id)) return p("youAreOut", `You finished ${ordinal(tournament.place(g.tournament, me.id) ?? 0)}.`, tournament.place(g.tournament, me.id) ?? 0);
    const fromRules = rules.prompt(slot.round, meId);
    if (fromRules) return fromRules;
    const actor = slot.schedule.actorId;
    return me && actor === me.id ? p("yourTurn", "Your turn.") : p("waitingFor", `Waiting for ${name(actor)}.`, name(actor));
  }

  // `viewerId` null is a display: it sees what everyone at the table sees and has nothing to do.
  function view(g: EngineState, viewerId: string | null, options: Record<string, boolean>, context: { version: number; roomId: string }): View {
    const now = actionMs(g);
    const records = g.slot ? rules.records(g.slot.round) : [];
    const redacted = g.slot ? views.redact(viewerId, records) : [];
    const gameOf = new Map<string, Record<string, unknown>>();
    records.forEach((r: HiddenRecord, i: number) => {
      if (r.ownerId !== null) gameOf.set(r.ownerId, redacted[i]);
    });
    const lobby = g.status === "lobby";
    const players: PlayerRow[] = seating.list(g.seats).map((s) => ({
      id: s.id, name: s.name, seat: s.seat, isBot: s.computer, isHost: s.id === seating.hostOf(g.seats),
      stack: lobby ? 0 : tournament.balance(g.tournament, s.id),
      status: lobby || tournament.isActive(g.tournament, s.id) ? "in" : "out",
      place: lobby ? null : tournament.place(g.tournament, s.id),
      connected: presence.isConnected(g.presence, s.id), sittingOut: presence.isSittingOut(g.presence, s.id),
      rebuysUsed: lobby ? 0 : tournament.rebuysUsed(g.tournament, s.id),
      game: gameOf.get(s.id) ?? null,
    }));
    const legal = legalFor(g, viewerId);
    const prompt = promptFor(g, viewerId, legal);
    const slot = g.slot;
    let round: RoundView | null = null;
    if (slot) {
      const sch = slot.schedule;
      const actor = sch.actorId;
      const countdown = actor && !actsFor(g, actor) && sch.deadline !== null && sch.settleUntil !== null && sch.deadline > sch.settleUntil ? sch.deadline : null;
      const remaining = slot.stage === "acting" ? countdown : slot.stage === "auto" ? sch.autoAt : sch.overAt;
      round = {
        no: slot.no, level: slot.level, stage: slot.stage, actorId: actor,
        remainingMs: remaining === null ? null : Math.max(0, remaining - now),
        settleMs: slot.stage === "acting" && sch.settleUntil !== null ? Math.max(0, sch.settleUntil - now) : null,
        event: slot.stage === "acting" ? sch.event : null,
        lastActorId: slot.stage === "acting" ? sch.lastActorId : null,
      };
    }
    return {
      version: context.version, roomId: context.roomId, gameNumber: g.gameNumber, you: viewerId ?? "", display: viewerId === null,
      status: g.status, phase: phaseOf(g), pauseReasons: presence.pauseReasons(g.presence),
      holds: g.status === "running" ? presence.holds(g.presence) : [], hostId: seating.hostOf(g.seats), players, round,
      game: slot ? rules.publicView(slot.round, viewerId, options) : null, lastResult: g.lastResult,
      clock: g.status === "running" ? tournament.clockInfo(levelMs(g)) : null,
      rebuyOffers: tournament.offers(g.tournament).map((o) => ({ playerId: o.playerId, remainingMs: Math.max(0, o.deadline - now) })),
      winnerId: tournament.winner(g.tournament), history: history.list(g.history),
      legal, prompt: prompt.text, promptKey: prompt.key, promptArgs: prompt.args,
    };
  }

  return { settings: cfg, create, validState, join, apply, cancelByWatcher, advance, computerDue, computerMove, nextWake, seen, setLive, away, setHold, view, legalFor, isPaused: paused, betweenRounds };
}

export type Engine = ReturnType<typeof createEngine>;
