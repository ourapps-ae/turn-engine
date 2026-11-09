// The GameAdapter that components/realtime-rooms calls (14 methods), over the turn engine.
// Wire actions are the engine's own (start, addBot, kick, leave, sitOut, return, pause, resume,
// cancel, newGame, rebuy) plus whatever the game's `parseMove` accepts.
import { createEngine, type EngineAction, type EngineSettings, type EngineState, type ErrorCode, type View } from "./engine.ts";
import type { Hold, Parts } from "./parts.ts";

// The shapes realtime-rooms/implementation/server/adapter.ts declares.
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; status: 400 | 409 | 422 } };
export type Deps = { now: () => number; rng: () => number; newId: () => string };
export type Actor = { id: string; role: "player" | "spectator" | "display" };
export type PresenceEvent = { type: "request-seen"; id: string } | { type: "live-members"; ids: string[] } | { type: "away"; id: string } | { type: "last-connection-close"; id: string; deliberate: boolean };
export type RoomInfo = { id: string; status: string; playerCount: number; names: string[] };
export interface GameAdapter<S, A, V, O> {
  create(now: number): S;
  restore(saved: unknown, schema: number): S;
  options(input: unknown): Result<O>;
  members(state: S): { id: string; name: string }[];
  summary(state: S): Omit<RoomInfo, "id">;
  clearSpectators(state: S): boolean;
  join(state: S, id: string, name: string, rejoining: boolean, deps: Deps): Result<{ state: S; role: "player" | "spectator" }>;
  parseAction(input: unknown): Result<{ action: A; requiresVersion: boolean; leaves: boolean }>;
  apply(state: S, actor: Actor, action: A, deps: Deps): Result<S>;
  presence(state: S, event: PresenceEvent, deps: Deps): { state: S; changed: boolean };
  connection(state: S, actor: Actor, message: unknown, options: O, deps: Deps): Result<{ state: S; options: O; changed: boolean }>;
  advance(state: S, deps: Deps): { state: S; changed: boolean };
  nextWake(state: S): number | null;
  view(state: S, actor: Actor | null, options: O, context: { version: number; roomId: string }): V;
}

export type Options = Record<string, boolean>;

const MESSAGES: Record<ErrorCode, string> = {
  badName: "Name must be 1 to 20 plain characters and not already taken.",
  badRequest: "Malformed request.",
  badToken: "Unknown player token.",
  roomFull: "The room is full.",
  staleVersion: "The table has changed. Look again.",
  notYourTurn: "It is not your turn.",
  wrongPhase: "That is not possible right now.",
  notEnoughPlayers: "Not enough players to start.",
  badAmount: "That amount is not allowed.",
  badTarget: "You cannot remove that player.",
  notAllowed: "You cannot do that.",
  paused: "The game is paused.",
  unknownPlayer: "That player is not in this game.",
};
const STATUS: Record<ErrorCode, 400 | 409 | 422> = { badName: 400, badRequest: 400, roomFull: 409, staleVersion: 409, badToken: 422, notYourTurn: 422, wrongPhase: 422, notEnoughPlayers: 422, badAmount: 422, badTarget: 422, notAllowed: 422, paused: 422, unknownPlayer: 422 };
const ENGINE_NO_ARGUMENTS = ["start", "addBot", "leave", "sitOut", "return", "pause", "resume", "cancel", "newGame"] as const;

function fail<T>(code: ErrorCode): Result<T> {
  return { ok: false, error: { code, message: MESSAGES[code], status: STATUS[code] } };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const holdKind = (v: unknown): Hold | null => (v === "look" || v === "learn" ? v : null);

export function createGameAdapter(parts: Parts, settings: Partial<EngineSettings> = {}): GameAdapter<EngineState, EngineAction, View, Options> {
  const engine = createEngine(parts, settings);
  const { seating, rules } = parts;

  return {
    create: (now) => engine.create(now),
    restore(saved, schema) {
      if (schema !== 1 || !engine.validState(saved)) throw new Error("Unsupported game state.");
      return saved;
    },
    options(input) {
      const b = input as Record<string, unknown> | null;
      const out: Options = {};
      for (const name of rules.optionNames) out[name] = b?.[name] === true || b?.[name] === "1";
      return ok(out);
    },
    members: (s) => seating.list(s.seats).map(({ id, name }) => ({ id, name })),
    summary: (s) => ({ status: s.status, playerCount: seating.count(s.seats), names: seating.list(s.seats).map((p) => p.name) }),
    clearSpectators: (s) => s.status === "lobby" && seating.count(s.seats) === 0,
    join(s, id, name, rejoining, deps) {
      if (!seating.validName(name)) return fail("badName");
      let game: EngineState = s;
      if (rejoining) {
        game = engine.seen(game, id, deps.now());
        if (game.status === "running") {
          const r = engine.apply(game, id, { type: "return" }, deps);
          if (r.ok) game = r.game;
        }
      } else if (game.status === "lobby") {
        const r = engine.join(game, id, name, deps.now());
        if (!r.ok) return fail(r.code);
        game = r.game;
      } else return ok({ state: s, role: "spectator" as const });
      return ok({ state: game, role: "player" as const });
    },
    parseAction(input) {
      const b = input as Record<string, unknown> | null;
      let action: EngineAction;
      const type = b?.type;
      if ((ENGINE_NO_ARGUMENTS as readonly unknown[]).includes(type)) action = { type: type as (typeof ENGINE_NO_ARGUMENTS)[number] };
      else if (type === "kick") {
        if (typeof b!.playerId !== "string") return fail("badRequest");
        action = { type: "kick", playerId: b!.playerId };
      } else if (type === "rebuy") {
        if (typeof b!.accept !== "boolean") return fail("badRequest");
        action = { type: "rebuy", accept: b!.accept };
      } else {
        const m = rules.parseMove(input);
        if (!m.ok) return fail("badRequest");
        action = { type: "move", move: m.move, needsTurn: m.needsTurn };
      }
      return ok({ action, requiresVersion: action.type !== "leave", leaves: action.type === "leave" });
    },
    apply(s, actor, action, deps) {
      if (actor.role === "display") return fail("notAllowed");
      if (actor.role === "spectator") {
        if (action.type === "leave") return ok(s);
        if (action.type !== "cancel") return fail("notAllowed");
        const r = engine.cancelByWatcher(s, deps.now());
        return r.ok ? ok(r.game) : fail(r.code);
      }
      const r = engine.apply(s, actor.id, action, deps);
      return r.ok ? ok(r.game) : fail(r.code);
    },
    presence(s, event, deps) {
      let game = s;
      let changed = false;
      const connected = (g: EngineState, id: string) => parts.presence.isConnected(g.presence, id);
      if (event.type === "live-members") {
        for (const p of seating.people(s.seats)) {
          const want = event.ids.includes(p.id);
          if (parts.presence.isLive(game.presence, p.id) !== want) {
            const wasConnected = connected(game, p.id);
            game = engine.setLive(game, p.id, want, deps.now());
            changed ||= !wasConnected && want;
          }
        }
      } else if (event.type === "request-seen") {
        const wasConnected = seating.find(s.seats, event.id) ? connected(s, event.id) : true;
        game = engine.seen(s, event.id, deps.now());
        changed = game !== s && !wasConnected;
      } else if (event.type === "away") {
        game = engine.away(s, event.id);
        changed = game !== s;
      } else {
        const before = seating.find(s.seats, event.id) ? connected(s, event.id) : null;
        game = engine.setHold(game, event.id, null);
        changed = game !== s;
        game = engine.setLive(game, event.id, false, deps.now());
        if (event.deliberate) game = engine.away(game, event.id);
        changed ||= (seating.find(game.seats, event.id) ? connected(game, event.id) : null) !== before;
      }
      return { state: game, changed };
    },
    connection(s, actor, input, options) {
      const m = input as { type?: unknown; on?: unknown; hold?: unknown; kind?: unknown } | null;
      let game = s;
      let next = options;
      // An option is switched by a message named for it: {type: "odds", on: true}.
      if (typeof m?.type === "string" && rules.optionNames.includes(m.type)) next = { ...options, [m.type]: m.on === true };
      if (actor.role === "player" && (m?.type === "hold" || (m?.type === "hello" && m.hold !== undefined))) game = engine.setHold(game, actor.id, holdKind(m.type === "hold" ? m.kind : m.hold));
      return ok({ state: game, options: next, changed: game !== s });
    },
    advance(s, deps) {
      let game = s;
      let changed = false;
      for (let i = 0; i < 60; i++) {
        const r = engine.advance(game, deps);
        game = r.game;
        changed ||= r.changed;
        const m = engine.computerMove(game, deps);
        if (!m.moved) break;
        game = m.game;
        changed = true;
      }
      return { state: game, changed };
    },
    nextWake: (s) => engine.nextWake(s),
    view: (s, actor, options, context) => engine.view(s, actor?.id ?? null, options, context),
  };
}
