// Fakes for every interface the turn engine requires, written for these tests only: small, pure,
// and honest to the contract in interfaces/required/*.json. Nothing here knows poker.
import type { ClockApi, ComputersApi, GameRules, HistoryApi, HiddenRecord, Hold, Parts, PresenceApi, PrivateViewsApi, RulesSettingsApi, SeatingApi, TournamentApi } from "../../implementation/server/parts.ts";

export const PRESENCE_MS = 30_000;
export const LEVEL_MS = 600_000;
export const START_STACK = 100;
export const ANTE = 40;
export const TARGET = 5;

type Ledger = { balances: Record<string, number>; issued: number };
const clone = <T>(v: T): T => structuredClone(v);

// ---- game-rules: a two-or-more player counting game with a pot -----------------------------
// Players take turns adding 1 or 2 to a count; whoever reaches TARGET takes the antes.
type Round = {
  no: number; level: number; ids: string[]; actor: string | null; total: number; phase: "play" | "reveal" | "over";
  antes: Record<string, number>; pot: number; winner: string | null; moves: number; lastActor: string | null; secrets: Record<string, number>;
};
export const rules: GameRules = {
  optionNames: ["hint"],
  newRound({ no, level, players, carry }, ledger, rng) {
    const l = clone(ledger as Ledger);
    const ids = players.map((p) => p.id);
    const first = (carry as { first: number } | null)?.first ?? 0;
    const antes: Record<string, number> = {};
    let pot = 0;
    for (const id of ids) {
      const a = Math.min(ANTE, l.balances[id] ?? 0);
      antes[id] = a;
      l.balances[id] -= a;
      pot += a;
    }
    const secrets = Object.fromEntries(ids.map((id) => [id, Math.floor(rng() * 1000)]));
    const round: Round = { no, level, ids, actor: ids[first % ids.length], total: 0, phase: "play", antes, pot, winner: null, moves: 0, lastActor: null, secrets };
    return { round, ledger: l, carry: { first: (first + 1) % ids.length } };
  },
  phase(r, pacing) {
    const round = r as Round;
    if (round.phase === "play") return { stage: "acting", actorId: round.actor, settleMs: pacing.settleMs, autoDelayMs: null, event: round.moves === 0 ? "deal" : "move", lastActorId: round.lastActor };
    if (round.phase === "reveal") return { stage: "auto", actorId: null, settleMs: 0, autoDelayMs: 1000, event: "reveal", lastActorId: round.lastActor };
    return { stage: "over", actorId: null, settleMs: 0, autoDelayMs: null, event: null, lastActorId: null };
  },
  parseMove(input) {
    const b = input as { type?: unknown; n?: unknown } | null;
    if (b?.type !== "add" || typeof b.n !== "number") return { ok: false };
    return { ok: true, move: { n: b.n }, needsTurn: true };
  },
  act(r, ledger, id, move, _context) {
    const round = clone(r as Round);
    if (round.phase !== "play") return { ok: false, code: "wrongPhase" };
    if (round.actor !== id) return { ok: false, code: "notYourTurn" };
    const n = (move as { n: number }).n;
    // Codes a game such as holdem-rules reports: two the engine lists, one it does not.
    if (n === 99) return { ok: false, code: "unknownPlayer" };
    if (n === 98) return { ok: false, code: "notEnoughPlayers" };
    if (n === 97) return { ok: false, code: "mystery" as never };
    if (n !== 1 && n !== 2) return { ok: false, code: "badAmount" };
    round.total += n;
    round.moves += 1;
    round.lastActor = id;
    if (round.total >= TARGET) {
      round.phase = "reveal";
      round.winner = id;
      round.actor = null;
    } else round.actor = round.ids[(round.ids.indexOf(id) + 1) % round.ids.length];
    return { ok: true, round, ledger };
  },
  defaultMove: () => ({ n: 1 }),
  step(r, ledger) {
    const round = clone(r as Round);
    const l = clone(ledger as Ledger);
    if (round.phase === "reveal") {
      l.balances[round.winner!] += round.pot;
      round.phase = "over";
    }
    return { round, ledger: l };
  },
  outcome(r) {
    const round = r as Round;
    return round.phase === "over" ? { holdMs: 5000, voided: false, result: { no: round.no, winnerId: round.winner, pot: round.pot, total: round.total }, historyEntry: { winnerId: round.winner, pot: round.pot } } : null;
  },
  voidRound(r, ledger) {
    const round = clone(r as Round);
    const l = clone(ledger as Ledger);
    if (round.phase !== "over") for (const id of round.ids) l.balances[id] += round.antes[id];
    round.phase = "over";
    return { round, ledger: l, outcome: { holdMs: 0, voided: true, result: { no: round.no, voided: true }, historyEntry: {} } };
  },
  observation(r, id) {
    const round = r as Round;
    return { total: round.total, target: TARGET, me: id };
  },
  records(r): HiddenRecord[] {
    const round = r as Round;
    return round.ids.map((id) => ({ ownerId: id, open: { moves: round.moves }, hidden: { secret: round.secrets[id] }, revealed: round.phase === "over" ? { secret: true } : {} }));
  },
  publicView(r, viewerId, options) {
    const round = r as Round;
    return { total: round.total, target: TARGET, pot: round.pot, phase: round.phase, hint: options.hint && viewerId !== null ? TARGET - round.total : null };
  },
  legal(r, viewerId, context) {
    const round = r as Round;
    return { add: round.phase === "play" && round.actor === viewerId && !context.paused ? [1, 2] : [] };
  },
  prompt(r) {
    const round = r as Round;
    return round.phase === "over" ? { key: "roundWon", args: [round.winner ?? ""], text: `${round.winner} reached ${TARGET}.` } : null;
  },
};

// ---- private-views ---------------------------------------------------------------------------
export const views: PrivateViewsApi = {
  redact(viewerId, records) {
    return records.map((r) => {
      const out: Record<string, unknown> = { ...r.open };
      for (const [key, value] of Object.entries(r.hidden)) {
        const shown = viewerId !== null && viewerId === r.ownerId ? true : r.revealed[key] === true;
        out[key] = shown ? value : null;
      }
      return out;
    });
  },
};

// ---- game-clock ------------------------------------------------------------------------------
type Clock = { action: number; level: number; at: number };
export const clock: ClockApi = {
  create: (now) => ({ action: 0, level: 0, at: now }) as Clock,
  advance(c, now, runs) {
    const k = c as Clock;
    const dt = Math.max(0, now - k.at);
    return { action: k.action + (runs.action ? dt : 0), level: k.level + (runs.level ? dt : 0), at: now } as Clock;
  },
  reset: (c, now) => ({ action: 0, level: 0, at: now }) as Clock,
  elapsed: (c, which) => (c as Clock)[which],
  wallAt: (c, which, target) => (c as Clock).at + Math.max(0, target - (c as Clock)[which]),
};

// ---- seating ---------------------------------------------------------------------------------
type Seats = { seats: { id: string; name: string; seat: number; computer: boolean }[]; hostId: string | null; left: string[] };
export function makeSeating(options: { minimum?: number; maximum?: number; returnToStack?: boolean } = {}): SeatingApi {
  const min = options.minimum ?? 2;
  const max = options.maximum ?? 4;
  const returnToStack = options.returnToStack ?? true;
  const by = (a: { seat: number }, b: { seat: number }) => a.seat - b.seat;
  const s: SeatingApi = {
    create: (): Seats => ({ seats: [], hostId: null, left: [] }),
    validName: (n) => typeof n === "string" && /^[A-Za-z ]{1,20}$/.test(n) && n.trim() === n,
    list: (st) => [...(st as Seats).seats].sort(by),
    find: (st, id) => (st as Seats).seats.find((p) => p.id === id),
    count: (st) => (st as Seats).seats.length,
    people: (st) => (st as Seats).seats.filter((p) => !p.computer),
    isFull: (st) => (st as Seats).seats.length >= max,
    isEnough: (st) => (st as Seats).seats.length >= min,
    minimumPlayers: () => min,
    hostOf: (st) => (st as Seats).hostId,
    join(st, id, name, opts) {
      const g = clone(st as Seats);
      if (!s.validName(name) || g.seats.some((p) => p.name === name || p.id === id)) return { ok: false, code: "badName" };
      if (g.seats.length >= max) return { ok: false, code: "roomFull" };
      const taken = new Set(g.seats.map((p) => p.seat));
      let seat = 0;
      while (taken.has(seat)) seat++;
      g.seats.push({ id, name, seat, computer: opts?.computer === true });
      return { ok: true, state: g };
    },
    setHost: (st, id) => ({ ...clone(st as Seats), hostId: id }),
    leave(st, id) {
      const g = clone(st as Seats);
      g.seats = g.seats.filter((p) => p.id !== id);
      if (g.hostId === id) g.hostId = null;
      return g;
    },
    leaveRunning(st, id) {
      if (returnToStack) return st;
      const g = clone(st as Seats);
      g.left.push(id);
      return g;
    },
    mayReturn: (st, id) => (st as Seats).seats.some((p) => p.id === id) && (returnToStack || !(st as Seats).left.includes(id)),
    returned(st, id) {
      const g = clone(st as Seats);
      g.left = g.left.filter((x) => x !== id);
      return g;
    },
    remove(st, byId, targetId) {
      const g = st as Seats;
      const who = g.seats.find((p) => p.id === byId);
      const target = g.seats.find((p) => p.id === targetId);
      if (!who || who.computer) return { ok: false, code: "notAllowed" };
      if (!target || !target.computer) return { ok: false, code: "badTarget" };
      return { ok: true, state: s.leave(st, targetId) };
    },
    canStart(st, byId) {
      const who = (st as Seats).seats.find((p) => p.id === byId);
      if (!who || who.computer) return { ok: false, code: "notAllowed" };
      return s.isEnough(st) ? { ok: true, state: st } : { ok: false, code: "notEnoughPlayers" };
    },
    canAddComputer(st, byId) {
      const who = (st as Seats).seats.find((p) => p.id === byId);
      if (!who || who.computer) return { ok: false, code: "notAllowed" };
      return s.isFull(st) ? { ok: false, code: "roomFull" } : { ok: true, state: st };
    },
    assign(st, rng) {
      const g = clone(st as Seats);
      const order = [...g.seats].sort(by);
      const seats = order.map((_, i) => i);
      for (let i = seats.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [seats[i], seats[j]] = [seats[j], seats[i]];
      }
      order.forEach((p, i) => (p.seat = seats[i]));
      g.seats.sort(by);
      return g;
    },
    retain(st, keep) {
      const g = clone(st as Seats);
      g.seats = g.seats.filter(keep).sort(by);
      g.seats.forEach((p, i) => (p.seat = i));
      g.left = [];
      g.hostId = null;
      return g;
    },
    compact: (st) => st,
  };
  return s;
}

// ---- presence --------------------------------------------------------------------------------
type Person = { kind: "person" | "computer"; connected: boolean; live: boolean; sittingOut: boolean; misses: number; lastSeen: number };
type Pres = { people: Record<string, Person>; manual: boolean; manualAt: number | null; holds: Record<string, Hold>; hostAbsent: boolean; allOffline: boolean; pausedSince: number | null };
export const presence: PresenceApi = {
  create: (): Pres => ({ people: {}, manual: false, manualAt: null, holds: {}, hostAbsent: false, allOffline: false, pausedSince: null }),
  register(st, id, now, kind) {
    const g = clone(st as Pres);
    g.people[id] = { kind, connected: true, live: false, sittingOut: false, misses: 0, lastSeen: now };
    return g;
  },
  unregister(st, id) {
    const g = clone(st as Pres);
    delete g.people[id];
    delete g.holds[id];
    return g;
  },
  restart(st, keepIds) {
    const g = clone(st as Pres);
    for (const id of Object.keys(g.people)) {
      if (!keepIds.includes(id)) delete g.people[id];
      else Object.assign(g.people[id], { sittingOut: false, misses: 0 });
    }
    return { ...g, manual: false, holds: {}, hostAbsent: false, allOffline: false, pausedSince: null };
  },
  seen(st, id, now) {
    const p = (st as Pres).people[id];
    if (!p || (p.connected && p.lastSeen === now)) return st;
    const g = clone(st as Pres);
    g.people[id].lastSeen = now;
    if (!g.people[id].connected) Object.assign(g.people[id], { connected: true, misses: 0 });
    return g;
  },
  setLive(st, id, live, now) {
    const p = (st as Pres).people[id];
    if (!p || p.kind === "computer" || p.live === live) return st;
    const g = clone(st as Pres);
    const q = g.people[id];
    q.live = live;
    q.lastSeen = now;
    if (live && !q.connected) Object.assign(q, { connected: true, misses: 0 });
    return g;
  },
  away(st, id) {
    const p = (st as Pres).people[id];
    if (!p || !p.connected) return st;
    const g = clone(st as Pres);
    g.people[id].connected = false;
    return g;
  },
  sitOut(st, id) {
    const g = clone(st as Pres);
    g.people[id].sittingOut = true;
    return g;
  },
  returned(st, id, now) {
    const g = clone(st as Pres);
    Object.assign(g.people[id], { sittingOut: false, misses: 0, connected: true, lastSeen: now });
    return g;
  },
  leftGame(st, id) {
    const g = clone(st as Pres);
    Object.assign(g.people[id], { sittingOut: true, connected: false });
    return g;
  },
  recordMiss(st, id) {
    const g = clone(st as Pres);
    g.people[id].misses += 1;
    return g;
  },
  isConnected: (st, id) => (st as Pres).people[id]?.connected ?? false,
  isLive: (st, id) => (st as Pres).people[id]?.live ?? false,
  isSittingOut: (st, id) => (st as Pres).people[id]?.sittingOut ?? false,
  misses: (st, id) => (st as Pres).people[id]?.misses ?? 0,
  lastSeen: (st, id) => (st as Pres).people[id]?.lastSeen ?? 0,
  refresh(st, now, ctx) {
    const g = clone(st as Pres);
    for (const p of Object.values(g.people)) if (p.kind === "person" && p.connected && !p.live && now - p.lastSeen > PRESENCE_MS) p.connected = false;
    for (const id of Object.keys(g.holds)) {
      const p = g.people[id];
      if (!ctx.running || !p || !p.connected || (g.holds[id] === "look" && !ctx.roundOver)) delete g.holds[id];
    }
    if (ctx.running) {
      const host = ctx.hostId ? g.people[ctx.hostId] : undefined;
      g.hostAbsent = !!host && !host.connected;
      const humans = ctx.activeIds.map((id) => g.people[id]).filter((p) => p && p.kind === "person");
      g.allOffline = humans.length > 0 && !humans.some((p) => p.connected);
      const paused = g.hostAbsent || g.allOffline || g.manual;
      g.pausedSince = paused ? (g.pausedSince ?? now) : null;
    }
    return g;
  },
  setManualPause(st, on, now) {
    const g = clone(st as Pres);
    g.manual = on;
    g.manualAt = on ? now : null;
    return g;
  },
  setHold(st, id, kind) {
    const g = clone(st as Pres);
    if (kind === null) delete g.holds[id];
    else g.holds[id] = kind;
    return g;
  },
  isPaused: (st) => (st as Pres).hostAbsent || (st as Pres).allOffline || (st as Pres).manual,
  pauseReasons: (st) => [(st as Pres).hostAbsent && "hostAbsent", (st as Pres).allOffline && "allOffline", (st as Pres).manual && "manual"].filter(Boolean) as string[],
  isManualPause: (st) => (st as Pres).manual,
  pausedSince: (st) => (st as Pres).pausedSince,
  isHeld: (st) => Object.keys((st as Pres).holds).length > 0,
  holds: (st) => Object.entries((st as Pres).holds).map(([playerId, kind]) => ({ playerId, kind })),
  nextWake(st) {
    const times = Object.values((st as Pres).people).filter((p) => p.kind === "person" && p.connected && !p.live).map((p) => p.lastSeen + PRESENCE_MS + 1);
    return times.length ? Math.min(...times) : null;
  },
};

// ---- tournament (rebuys optional) ----------------------------------------------------------
type Entry = { id: string; status: "in" | "out"; place: number | null; rebuys: number; startStack: number };
type Tour = { entries: Entry[]; ledger: Ledger; offers: { playerId: string; deadline: number; autoAt: number | null }[]; pending: string[]; winner: string | null; finished: boolean };
export function makeTournament(options: { rebuys?: boolean } = {}): TournamentApi {
  const bal = (t: Tour, id: string) => t.ledger.balances[id] ?? 0;
  const api: TournamentApi = {
    create: (): Tour => ({ entries: [], ledger: { balances: {}, issued: 0 }, offers: [], pending: [], winner: null, finished: false }),
    start(seats) {
      const t = api.create() as Tour;
      for (const p of (seats as Seats).seats) {
        t.entries.push({ id: p.id, status: "in", place: null, rebuys: 0, startStack: START_STACK });
        t.ledger.balances[p.id] = START_STACK;
        t.ledger.issued += START_STACK;
      }
      return t;
    },
    activeIds: (t) => (t as Tour).entries.filter((e) => e.status === "in").map((e) => e.id),
    isActive: (t, id) => (t as Tour).entries.find((e) => e.id === id)?.status === "in",
    balance: (t, id) => bal(t as Tour, id),
    rebuysUsed: (t, id) => (t as Tour).entries.find((e) => e.id === id)?.rebuys ?? 0,
    place: (t, id) => (t as Tour).entries.find((e) => e.id === id)?.place ?? null,
    ledger: (t) => (t as Tour).ledger,
    withLedger: (t, ledger) => ({ ...clone(t as Tour), ledger: clone(ledger as Ledger) }),
    levelAt: (ms) => Math.floor(ms / LEVEL_MS) + 1,
    clockInfo: (ms) => ({ level: Math.floor(ms / LEVEL_MS) + 1, nextLevelInMs: LEVEL_MS - (ms % LEVEL_MS) }),
    rebuyStack: () => START_STACK,
    roundStarted(t) {
      const g = clone(t as Tour);
      for (const e of g.entries) if (e.status === "in") e.startStack = bal(g, e.id);
      return g;
    },
    roundSettled(t, input) {
      const g = clone(t as Tour);
      const busted = g.entries.filter((e) => e.status === "in" && bal(g, e.id) === 0);
      g.pending = busted.map((e) => e.id);
      if (options.rebuys) {
        for (const e of busted) {
          if (e.rebuys < 1 && input.level <= 3) {
            const computer = (input.seats as Seats).seats.find((p) => p.id === e.id)?.computer === true;
            g.offers.push({ playerId: e.id, deadline: input.actionMs + 30_000, autoAt: computer ? input.actionMs + input.computerDelayMs : null });
          }
        }
      }
      return g;
    },
    offers: (t) => (t as Tour).offers,
    hasOffers: (t) => (t as Tour).offers.length > 0,
    levelClockRuns: (t) => (t as Tour).offers.length === 0,
    offerFor: (t, id) => (t as Tour).offers.find((o) => o.playerId === id),
    dueOffer(t, ms, seats) {
      for (const o of (t as Tour).offers) {
        const computer = (seats as Seats).seats.find((p) => p.id === o.playerId)?.computer === true;
        if (computer && o.autoAt !== null && ms >= o.autoAt) return { playerId: o.playerId, accept: true };
        if (!computer && ms >= o.deadline) return { playerId: o.playerId, accept: false };
      }
      return null;
    },
    nextOfferDue(t, seats) {
      const times = (t as Tour).offers.map((o) => ((seats as Seats).seats.find((p) => p.id === o.playerId)?.computer ? (o.autoAt ?? o.deadline) : o.deadline));
      return times.length ? Math.min(...times) : null;
    },
    resolve(t, id, accept) {
      if (!(t as Tour).offers.some((o) => o.playerId === id)) return { ok: false, code: "notAllowed" };
      const g = clone(t as Tour);
      g.offers = g.offers.filter((o) => o.playerId !== id);
      if (accept) {
        g.ledger.balances[id] += START_STACK;
        g.ledger.issued += START_STACK;
        g.entries.find((e) => e.id === id)!.rebuys += 1;
        g.pending = g.pending.filter((x) => x !== id);
      }
      return { ok: true, state: g };
    },
    conclude(t, seats) {
      const g = clone(t as Tour);
      const out = g.entries.filter((e) => g.pending.includes(e.id) && e.status === "in" && bal(g, e.id) === 0);
      const slots = g.entries.filter((e) => e.status === "in").length;
      for (const e of out) Object.assign(e, { status: "out", place: slots - out.length + 1 });
      g.pending = [];
      const active = g.entries.filter((e) => e.status === "in");
      if (active.length === 1) {
        active[0].place = 1;
        g.winner = active[0].id;
        g.finished = true;
        return { state: g, outcome: "completed", winnerId: g.winner };
      }
      if (!active.some((e) => (seats as Seats).seats.find((p) => p.id === e.id && !p.computer))) {
        const best = [...active].sort((a, b) => bal(g, b.id) - bal(g, a.id));
        best.forEach((e, i) => (e.place = i + 1));
        g.winner = best[0].id;
        g.finished = true;
        return { state: g, outcome: "completed", winnerId: g.winner };
      }
      return { state: g, outcome: "continue", winnerId: null };
    },
    cancel(t) {
      const g = clone(t as Tour);
      Object.assign(g, { offers: [], pending: [], winner: null, finished: true });
      return g;
    },
    winner: (t) => (t as Tour).winner,
  };
  return api;
}

// ---- computer-players ------------------------------------------------------------------------
export function makeComputers(options: { fill?: boolean; takeOverAbsent?: boolean; names?: string[]; maximum?: number } = {}): ComputersApi {
  const names = options.names ?? ["Ann", "Bob", "Cat"];
  const idFor = (n: string) => "computer-" + n.toLowerCase();
  const seating = makeSeating({ maximum: options.maximum });
  const api: ComputersApi = {
    create: () => ({ memory: {} as Record<string, number> }),
    forget: () => ({ memory: {} }),
    idFor,
    add(seats, byId) {
      const ok = seating.canAddComputer(seats, byId);
      if (!ok.ok) return ok;
      const name = names.find((n) => !(seats as Seats).seats.some((p) => p.name === n));
      if (!name) return { ok: false, code: "roomFull" };
      const r = seating.join(seats, idFor(name), name, { computer: true });
      return r.ok ? { ok: true, state: r.state, name } : r;
    },
    fill(seats) {
      const added: string[] = [];
      let state = seats;
      while (options.fill && !seating.isFull(state)) {
        const name = names.find((n) => !(state as Seats).seats.some((p) => p.name === n));
        if (!name) break;
        const r = seating.join(state, idFor(name), name, { computer: true });
        if (!r.ok) break;
        state = r.state;
        added.push(name);
      }
      return { state, added };
    },
    actsFor(seats, p) {
      if ((seats as Seats).seats.find((s) => s.id === p.id)?.computer) return true;
      return options.takeOverAbsent === true && (!p.connected || p.sittingOut);
    },
    moveDeadline: (c, settleUntil) => Math.max(settleUntil, (c as { action: number }).action + 4000) + 300,
    isDue: (c, deadline) => (c as { action: number }).action >= deadline,
    rebuyDelayMs: () => 4000,
    choose(state, observation) {
      const o = observation as { total: number; target: number };
      return { move: { n: o.total + 2 >= o.target ? 2 : 1 }, state };
    },
    observe(state, _observation, id) {
      const memory = clone((state as { memory: Record<string, number> }).memory);
      memory[id] = (memory[id] ?? 0) + 1;
      return { memory };
    },
  };
  return api;
}

// ---- round-history and rules-settings --------------------------------------------------------
export const history: HistoryApi = {
  create: () => [] as Record<string, unknown>[],
  push(h, entry) {
    const next = [...(h as Record<string, unknown>[]), entry];
    return next.slice(-50);
  },
  list: (h) => h as Record<string, unknown>[],
};
export const settingsFrom = (values: Record<string, unknown> = {}): RulesSettingsApi => ({ value: (path) => values[path] });

export type Setup = { rebuys?: boolean; fill?: boolean; takeOverAbsent?: boolean; returnToStack?: boolean; maximum?: number; decisionSeconds?: number; noComputers?: boolean };
export function makeParts(setup: Setup = {}): Parts {
  return {
    rules, seating: makeSeating({ returnToStack: setup.returnToStack, maximum: setup.maximum }), clock, views, presence,
    tournament: makeTournament({ rebuys: setup.rebuys }), ...(setup.noComputers ? {} : { computers: makeComputers({ fill: setup.fill, takeOverAbsent: setup.takeOverAbsent, maximum: setup.maximum }) }),
    history, settings: settingsFrom(setup.decisionSeconds === undefined ? { "timing.decision_seconds": 30 } : { "timing.decision_seconds": setup.decisionSeconds }),
  };
}
