import assert from "node:assert/strict";
import test from "node:test";
import { createGameAdapter, type Actor, type Deps } from "../implementation/server/adapter.ts";
import { asErrorCode, checkSettings, createEngine, ERROR_CODES, type EngineState } from "../implementation/server/engine.ts";
import { makeParts, PRESENCE_MS, START_STACK, ANTE, TARGET, type Setup } from "./fakes/parts.ts";
import { demo } from "../examples/consumer.ts";

// ---- a controllable world -------------------------------------------------------------------
function world(setup: Setup = {}) {
  const parts = makeParts(setup);
  const adapter = createGameAdapter(parts);
  let time = 1_000_000;
  let n = 0;
  const deps: Deps = { now: () => time, rng: () => 0.9, newId: () => "id" + n++ };
  const player = (id: string): Actor => ({ id, role: "player" });
  const w = {
    parts, adapter, deps, state: adapter.create(time),
    at: () => time,
    wait(ms: number) { time += ms; },
    // Run what has come due and let the people "poll" so nobody counts as absent.
    settle(...ids: string[]) {
      for (const id of ids) w.state = adapter.presence(w.state, { type: "request-seen", id }, deps).state;
      w.state = adapter.advance(w.state, deps).state;
    },
    join(id: string, name = id) {
      const r = adapter.join(w.state, id, name, false, deps);
      assert.ok(r.ok, JSON.stringify(r));
      w.state = r.value.state;
    },
    act(id: string, input: unknown) {
      const p = adapter.parseAction(input);
      if (!p.ok) return p;
      const r = adapter.apply(w.state, player(id), p.value.action, deps);
      if (r.ok) w.state = r.value;
      return r;
    },
    view(id: string | null, options: Record<string, boolean> = {}) {
      return adapter.view(w.state, id === null ? null : player(id), options, { version: 7, roomId: "room" });
    },
    // Wait until the wall time the engine asked to be woken at, then advance.
    wake() {
      const at = adapter.nextWake(w.state);
      assert.notEqual(at, null);
      time = Math.max(time, at!);
      w.state = adapter.advance(w.state, deps).state;
    },
    startTwo(host = "a") {
      w.join("a", "Ada");
      w.join("b", "Bea");
      const r = w.act(host, { type: "start" });
      assert.ok(r.ok, JSON.stringify(r));
    },
  };
  return w;
}
const ok = (r: { ok: boolean }) => assert.equal(r.ok, true, JSON.stringify(r));
const code = (r: unknown) => (r as { ok: false; error: { code: string } }).error?.code;
const game = (w: ReturnType<typeof world>) => w.view("a").game as { total: number; pot: number; phase: string };

test("settings are checked", () => {
  assert.deepEqual(checkSettings({}), { decisionSeconds: null, settleMs: 4000, staleMinutes: 30, standingsSeconds: 20, lobbyDropSeconds: 60 });
  assert.throws(() => checkSettings({ decisionSeconds: 0 }));
  assert.throws(() => checkSettings({ settleMs: -1 }));
  assert.throws(() => checkSettings({ staleMinutes: 0.5 }));
});

test("lobby: joining, names, room full, summary and members", () => {
  const w = world({ maximum: 3 });
  assert.equal(w.adapter.clearSpectators(w.state), true);
  w.join("a", "Ada");
  assert.equal(w.adapter.clearSpectators(w.state), false);
  assert.equal(code(w.adapter.join(w.state, "x", "bad name!", false, w.deps)), "badName");
  assert.equal(code(w.adapter.join(w.state, "x", "Ada", false, w.deps)), "badName");
  w.join("b", "Bea");
  w.join("c", "Cy");
  assert.equal(code(w.adapter.join(w.state, "d", "Di", false, w.deps)), "roomFull");
  assert.deepEqual(w.adapter.members(w.state), [{ id: "a", name: "Ada" }, { id: "b", name: "Bea" }, { id: "c", name: "Cy" }]);
  assert.deepEqual(w.adapter.summary(w.state), { status: "lobby", playerCount: 3, names: ["Ada", "Bea", "Cy"] });
  const v = w.view("a");
  assert.equal(v.phase, "lobby");
  assert.equal(v.legal.start, true);
  assert.equal(v.legal.kick, false);
  assert.equal(v.promptKey, "lobbyReady");
});

test("starting needs enough people and a person; the starter becomes host; everyone gets the starting stack", () => {
  const w = world();
  w.join("a", "Ada");
  assert.equal(code(w.act("a", { type: "start" })), "notEnoughPlayers");
  const waiting = w.view("a");
  assert.deepEqual([waiting.promptKey, waiting.promptArgs, waiting.prompt], ["lobbyWaitingOne", [1], "Waiting for 1 more player."]);
  ok(w.act("a", { type: "addBot" }));
  assert.equal(code(w.act("computer-ann", { type: "start" })), "notAllowed");
  ok(w.act("a", { type: "start" }));
  const v = w.view("a");
  assert.equal(v.status, "running");
  assert.equal(v.hostId, "a");
  assert.equal(v.gameNumber, 1);
  assert.deepEqual(v.players.map((p) => p.stack), v.players.map(() => START_STACK - ANTE));
  assert.equal(code(w.act("a", { type: "start" })), "wrongPhase");
  assert.equal(code(w.adapter.apply(w.state, { id: "zz", role: "player" }, { type: "start" }, w.deps)), "badToken");
});

test("computers: add, kick, only people may remove and only in the lobby", () => {
  const w = world();
  w.join("a", "Ada");
  ok(w.act("a", { type: "addBot" }));
  assert.equal(w.view("a").legal.kick, true);
  assert.equal(code(w.act("a", { type: "kick", playerId: "a" })), "badTarget");
  assert.equal(code(w.act("a", { type: "kick" })), "badRequest");
  ok(w.act("a", { type: "kick", playerId: "computer-ann" }));
  assert.equal(w.adapter.members(w.state).length, 1);
  ok(w.act("a", { type: "addBot" }));
  ok(w.act("a", { type: "start" }));
  assert.equal(code(w.act("a", { type: "addBot" })), "wrongPhase");
  assert.equal(code(w.act("a", { type: "kick", playerId: "computer-ann" })), "wrongPhase");
});

test("fill-empty seats computers on start", () => {
  const w = world({ fill: true, maximum: 3 });
  w.join("a", "Ada");
  w.join("b", "Bea");
  ok(w.act("a", { type: "start" }));
  assert.equal(w.adapter.members(w.state).length, 3);
  assert.equal(w.view("a").players.filter((p) => p.isBot).length, 1);
});

test("fill-empty: one person alone may start, and the computers fill the table", () => {
  const w = world({ fill: true, maximum: 4 });
  w.join("a", "Ada");
  const before = w.view("a");
  assert.equal(before.legal.start, true);
  assert.deepEqual([before.promptKey, before.promptArgs], ["lobbyFill", [3]]);
  ok(w.act("a", { type: "start" }));
  assert.equal(w.adapter.members(w.state).length, 4);
  assert.equal(w.view("a").status, "running");
  // without fill-empty a lone person still waits
  const plain = world({ maximum: 4 });
  plain.join("a", "Ada");
  assert.equal(plain.view("a").legal.start, false);
  assert.equal(code(plain.act("a", { type: "start" })), "notEnoughPlayers");
});

test("unknown and malformed actions are refused at parse time", () => {
  const w = world();
  for (const bad of [null, {}, { type: "nope" }, { type: "add" }, { type: "add", n: "1" }, { type: "rebuy" }, { type: "kick", playerId: 3 }]) assert.equal(code(w.adapter.parseAction(bad)), "badRequest", JSON.stringify(bad));
  const leave = w.adapter.parseAction({ type: "leave" });
  assert.ok(leave.ok && leave.value.leaves && !leave.value.requiresVersion);
  const mv = w.adapter.parseAction({ type: "add", n: 2 });
  assert.ok(mv.ok && !mv.value.leaves && mv.value.requiresVersion);
  assert.deepEqual(mv.ok && mv.value.action, { type: "move", move: { n: 2 }, needsTurn: true });
});

test("turn order and checked moves with error codes", () => {
  const w = world();
  w.startTwo();
  let v = w.view("a");
  assert.equal(v.phase, "acting");
  assert.equal(v.round?.actorId, "a");
  assert.equal(code(w.act("b", { type: "add", n: 1 })), "notYourTurn");
  assert.equal(code(w.act("a", { type: "add", n: 5 })), "badAmount");
  ok(w.act("a", { type: "add", n: 1 }));
  v = w.view("a");
  assert.equal(v.round?.actorId, "b");
  assert.equal(code(w.act("a", { type: "add", n: 1 })), "notYourTurn");
  assert.equal(code(w.adapter.apply(w.state, { id: "a", role: "display" }, { type: "move", move: { n: 1 }, needsTurn: true }, w.deps)), "notAllowed");
  assert.deepEqual((w.view("b").legal.game as { add: number[] }).add, [1, 2]);
  assert.deepEqual((w.view("a").legal.game as { add: number[] }).add, []);
  assert.equal(w.view("a").promptKey, "waitingFor");
  assert.equal(w.view("b").promptKey, "yourTurn");
});

test("a person's countdown runs after the settle; a missed turn plays the default move", () => {
  const w = world();
  w.startTwo();
  let r = w.view("a").round!;
  assert.equal(r.settleMs, 4000);
  assert.equal(r.remainingMs, 34_000, "the settle and then the decision time");
  w.wait(4000);
  w.settle("a", "b");
  r = w.view("a").round!;
  assert.equal(r.settleMs, 0);
  assert.equal(r.remainingMs, 30_000);
  w.wait(29_000);
  w.settle("a", "b");
  assert.equal(w.view("a").round!.actorId, "a");
  w.wait(1000);
  w.settle("a", "b");
  assert.equal(game(w).total, 1, "the default move was played for a");
  assert.equal(w.view("a").round!.actorId, "b");
});

test("an absent person is acted for when the countdown ends; their next turn is acted for at the end of the settle", () => {
  const w = world();
  w.startTwo("b");
  w.wait(PRESENCE_MS + 1);
  w.settle("b");
  assert.equal(w.view("b").players.find((p) => p.id === "a")!.connected, false);
  assert.deepEqual(w.view("b").pauseReasons, [], "the host is here, so the table runs");
  assert.equal(game(w).total, 0);
  w.wait(4000);
  w.settle("b");
  assert.equal(game(w).total, 1, "a was acted for when its countdown ended");
  ok(w.act("b", { type: "add", n: 1 }));
  assert.equal(w.view("b").round!.actorId, "a");
  assert.equal(w.view("b").round!.remainingMs, null, "no countdown for an absent person");
  w.wait(3999);
  w.settle("b");
  assert.equal(game(w).total, 2);
  w.wait(1);
  w.settle("b");
  assert.equal(game(w).total, 3, "a missed again and was acted for as soon as the settle ended");
});

test("a person who sat out and is back when the settle ends gets a full countdown", () => {
  const w = world();
  w.startTwo();
  ok(w.act("a", { type: "add", n: 1 }));
  ok(w.act("a", { type: "sitOut" }));
  ok(w.act("b", { type: "add", n: 1 }));
  assert.equal(w.view("a").round!.actorId, "a");
  assert.equal(w.view("a").round!.remainingMs, null, "sitting out: acted for at the end of the settle");
  ok(w.act("a", { type: "return" }));
  w.wait(4000);
  w.settle("a", "b");
  assert.equal(game(w).total, 2, "not acted for");
  assert.equal(w.view("a").round!.remainingMs, 30_000);
});

test("computers move by themselves through computerMove after settle, gap and thinking time", () => {
  const w = world();
  w.join("a", "Ada");
  ok(w.act("a", { type: "addBot" }));
  ok(w.act("a", { type: "start" }));
  assert.equal(w.view("a").round!.actorId, "a");
  ok(w.act("a", { type: "add", n: 1 }));
  assert.equal(w.view("a").round!.actorId, "computer-ann");
  assert.equal(w.view("a").round!.remainingMs, null, "a computer shows no countdown");
  w.settle("a");
  assert.equal(game(w).total, 1, "too early");
  w.wait(4299);
  w.settle("a");
  assert.equal(game(w).total, 1);
  w.wait(1);
  w.settle("a");
  assert.equal(game(w).total, 2, "the computer played the strategy's move (1 here)");
  assert.equal(w.view("a").round!.actorId, "a");
  assert.deepEqual(w.state.computers.memory, { a: 1, "computer-ann": 1 }, "both moves were observed by the strategy");
});

test("automatic steps then the result pause, the pot is awarded and the history records the round", () => {
  const w = world();
  w.startTwo();
  ok(w.act("a", { type: "add", n: 2 }));
  ok(w.act("b", { type: "add", n: 2 }));
  ok(w.act("a", { type: "add", n: 1 }));
  let v = w.view("a");
  assert.equal(v.phase, "auto");
  assert.equal(v.round!.remainingMs, 1000);
  assert.equal(game(w).pot, 2 * ANTE);
  w.settle("a", "b");
  assert.equal(game(w).phase, "reveal");
  w.wait(1000);
  w.settle("a", "b");
  v = w.view("a");
  assert.equal(v.phase, "over");
  assert.equal(v.round!.remainingMs, 5000);
  assert.deepEqual(v.players.map((p) => [p.id, p.stack]), [["a", START_STACK - ANTE + 2 * ANTE], ["b", START_STACK - ANTE]].sort() as [string, number][]);
  assert.equal(v.promptKey, "roundWon");
  assert.deepEqual(v.lastResult, { no: 1, winnerId: "a", pot: 2 * ANTE, total: TARGET });
  assert.deepEqual(v.history, [{ no: 1, level: 1, voided: false, winnerId: "a", pot: 2 * ANTE }]);
  assert.equal(code(w.act("b", { type: "add", n: 1 })), "wrongPhase");
  w.wait(5000);
  w.settle("a", "b");
  v = w.view("a");
  assert.equal(v.phase, "acting");
  assert.equal(v.round!.no, 2);
  assert.equal(v.round!.actorId, "b", "the game's carry moved the first mover on");
});

test("scheduled steps: nextWake names each due time and advance does nothing before it", () => {
  const w = world();
  assert.equal(w.adapter.nextWake(w.state), null);
  w.join("a", "Ada");
  assert.equal(w.adapter.nextWake(w.state), w.at() + 60_001, "a person not heard from is given up after a minute");
  w.state = w.adapter.presence(w.state, { type: "live-members", ids: ["a"] }, w.deps).state;
  assert.equal(w.adapter.nextWake(w.state), w.at() + 30 * 60_000, "an idle lobby goes stale");
  w.join("b", "Bea");
  w.state = w.adapter.presence(w.state, { type: "live-members", ids: ["a", "b"] }, w.deps).state;
  ok(w.act("a", { type: "start" }));
  assert.equal(w.adapter.nextWake(w.state), w.at() + 34_000, "live connections need no silence timer; the countdown is next");
  const before = JSON.stringify(w.state);
  const r = w.adapter.advance(w.state, w.deps);
  assert.equal(r.changed, false);
  assert.equal(JSON.stringify(r.state), before);
  ok(w.act("a", { type: "add", n: 2 }));
  ok(w.act("b", { type: "add", n: 2 }));
  ok(w.act("a", { type: "add", n: 1 }));
  assert.equal(w.adapter.nextWake(w.state), w.at() + 1000, "the automatic step");
});

test("pausing: manual by the host between rounds only, host absence and nobody online stop the clocks", () => {
  const w = world();
  w.startTwo();
  assert.equal(code(w.act("a", { type: "pause" })), "wrongPhase");
  ok(w.act("a", { type: "add", n: 2 }));
  ok(w.act("b", { type: "add", n: 2 }));
  ok(w.act("a", { type: "add", n: 1 }));
  w.wait(1000);
  w.settle("a", "b");
  assert.equal(w.view("b").legal.pause, false, "only the host");
  assert.equal(code(w.act("b", { type: "pause" })), "notAllowed");
  assert.equal(w.view("a").legal.pause, true);
  ok(w.act("a", { type: "pause" }));
  assert.deepEqual(w.view("a").pauseReasons, ["manual"]);
  assert.equal(w.view("a").promptKey, "pausedManual");
  assert.equal(w.view("a").legal.resume, true);
  const at = w.view("a").round!.remainingMs;
  w.wait(60_000);
  w.settle("a", "b");
  assert.equal(w.view("a").round!.remainingMs, at, "the action clock stood still");
  assert.equal(w.view("a").phase, "over");
  ok(w.act("a", { type: "resume" }));
  assert.deepEqual(w.view("a").pauseReasons, []);
  w.wait(5000);
  w.settle("a", "b");
  assert.equal(w.view("a").round!.no, 2);
  // Host goes away: paused, moves refused.
  w.wait(PRESENCE_MS + 1);
  w.settle("b");
  assert.deepEqual(w.view("b").pauseReasons, ["hostAbsent"]);
  assert.equal(code(w.act("b", { type: "add", n: 1 })), "paused");
  assert.equal(w.view("b").promptKey, "pausedHost");
  assert.deepEqual((w.view("b").legal.game as { add: number[] }).add, []);
});

test("a table paused with nobody connected is cancelled after the stale time", () => {
  const w = world();
  w.startTwo();
  w.wait(PRESENCE_MS + 1);
  w.state = w.adapter.advance(w.state, w.deps).state;
  assert.deepEqual(w.view("a").pauseReasons.sort(), ["allOffline", "hostAbsent"]);
  const wake = w.adapter.nextWake(w.state)!;
  w.wait(30 * 60_000 - 1);
  w.state = w.adapter.advance(w.state, w.deps).state;
  assert.equal(w.view("a").status, "running");
  w.wait(2000);
  w.state = w.adapter.advance(w.state, w.deps).state;
  assert.equal(w.view("a").status, "cancelled");
  assert.ok(wake > 0);
});

test("holds stop the clocks for everyone and go with the connection", () => {
  const w = world();
  w.startTwo();
  ok(w.act("a", { type: "add", n: 2 }));
  w.wait(4000);
  w.settle("a", "b");
  const hold = (id: string, kind: unknown) => { w.state = (w.adapter.connection(w.state, { id, role: "player" }, { type: "hold", kind }, {}, w.deps) as { value: { state: EngineState } }).value.state; };
  hold("b", "look");
  assert.deepEqual(w.view("a").holds, [], "look only counts after a round");
  hold("b", "learn");
  assert.deepEqual(w.view("a").holds, [{ playerId: "b", kind: "learn" }]);
  const left = w.view("a").round!.remainingMs;
  w.wait(20_000);
  w.state = w.adapter.advance(w.state, w.deps).state;
  assert.equal(w.view("a").round!.remainingMs, left);
  w.state = w.adapter.presence(w.state, { type: "last-connection-close", id: "b", deliberate: false }, w.deps).state;
  assert.deepEqual(w.view("a").holds, []);
  const opts = w.adapter.connection(w.state, { id: "a", role: "player" }, { type: "hint", on: true }, {}, w.deps);
  assert.ok(opts.ok && (opts.value.options as Record<string, boolean>).hint === true);
  assert.deepEqual(w.adapter.options({ hint: "1" }), { ok: true, value: { hint: true } });
  assert.deepEqual(w.adapter.options(null), { ok: true, value: { hint: false } });
});

test("leaving: the lobby seat is given up; in a game the person sits out and may return; the last person leaving empties the room", () => {
  const w = world();
  w.join("a", "Ada");
  w.join("b", "Bea");
  ok(w.act("b", { type: "leave" }));
  assert.equal(w.adapter.members(w.state).length, 1);
  ok(w.act("a", { type: "leave" }));
  assert.equal(w.adapter.members(w.state).length, 0);
  assert.equal(w.adapter.clearSpectators(w.state), true);
  w.startTwo();
  ok(w.act("b", { type: "leave" }));
  let v = w.view("a");
  assert.equal(v.players.find((p) => p.id === "b")!.sittingOut, true);
  assert.equal(v.players.find((p) => p.id === "b")!.connected, false);
  assert.equal(w.adapter.members(w.state).length, 2, "the seat is kept");
  assert.equal(v.legal.leave, true);
  const back = w.adapter.join(w.state, "b", "Bea", true, w.deps);
  assert.ok(back.ok && back.value.role === "player");
  w.state = (back as { value: { state: EngineState } }).value.state;
  v = w.view("a");
  assert.equal(v.players.find((p) => p.id === "b")!.sittingOut, false);
  assert.equal(v.players.find((p) => p.id === "b")!.connected, true);
  const watcher = w.adapter.join(w.state, "w", "Wes", false, w.deps);
  assert.ok(watcher.ok && watcher.value.role === "spectator");
});

test("without returnToStack a person who left a running game cannot come back", () => {
  const w = world({ returnToStack: false });
  w.startTwo();
  ok(w.act("b", { type: "leave" }));
  const back = w.adapter.join(w.state, "b", "Bea", true, w.deps);
  assert.ok(back.ok);
  w.state = (back as { value: { state: EngineState } }).value.state;
  assert.equal(w.view("a").players.find((p) => p.id === "b")!.sittingOut, true);
  assert.equal(code(w.act("b", { type: "return" })), "notAllowed");
});

test("sitting out and returning", () => {
  const w = world();
  w.startTwo();
  assert.equal(w.view("a").legal.sitOut, true);
  ok(w.act("a", { type: "sitOut" }));
  assert.equal(w.view("a").legal.return, true);
  assert.equal(w.view("a").legal.sitOut, false);
  ok(w.act("a", { type: "return" }));
  assert.equal(w.view("a").players[0].sittingOut, false);
  const lobby = world();
  lobby.join("a", "Ada");
  assert.equal(code(lobby.act("a", { type: "sitOut" })), "wrongPhase");
  assert.equal(code(lobby.act("a", { type: "return" })), "wrongPhase");
});

test("cancelling: any person ends the game, the round is voided, chips come back, a watcher may too", () => {
  const w = world();
  w.startTwo();
  ok(w.act("a", { type: "add", n: 1 }));
  ok(w.act("b", { type: "cancel" }));
  const v = w.view("a");
  assert.equal(v.status, "cancelled");
  assert.equal(v.promptKey, "cancelled");
  assert.deepEqual(v.players.map((p) => p.stack), [START_STACK, START_STACK]);
  assert.deepEqual(v.history, [{ no: 1, level: 1, voided: true }]);
  assert.equal(v.winnerId, null);
  assert.equal(v.legal.newGame, true);
  assert.equal(code(w.act("a", { type: "cancel" })), "wrongPhase");

  const x = world();
  x.startTwo();
  const watcher = x.adapter.apply(x.state, { id: "w", role: "spectator" }, { type: "cancel" }, x.deps);
  assert.ok(watcher.ok && watcher.value.status === "cancelled");
  assert.equal(code(x.adapter.apply(x.state, { id: "w", role: "spectator" }, { type: "start" }, x.deps)), "notAllowed");
  assert.ok(x.adapter.apply(x.state, { id: "w", role: "spectator" }, { type: "leave" }, x.deps).ok);
  const lobby = world();
  assert.equal(code(lobby.adapter.apply(lobby.state, { id: "w", role: "spectator" }, { type: "cancel" }, lobby.deps)), "wrongPhase");
});

test("the end: standings stay up, then newGame or the timeout makes a lobby of connected people and computers", () => {
  const w = world();
  w.startTwo();
  ok(w.act("b", { type: "cancel" }));
  w.state = w.adapter.presence(w.state, { type: "away", id: "b" }, w.deps).state;
  assert.equal(w.view("a").status, "cancelled");
  assert.equal(code(w.act("computer-x", { type: "newGame" })), "badToken");
  ok(w.act("a", { type: "newGame" }));
  const v = w.view("a");
  assert.equal(v.status, "lobby");
  assert.equal(v.gameNumber, 1);
  assert.deepEqual(v.players.map((p) => p.id), ["a"], "b was away and is dropped");
  assert.equal(v.hostId, null);
  assert.equal(code(w.act("a", { type: "newGame" })), "wrongPhase");

  const t = world();
  t.startTwo();
  ok(t.act("a", { type: "cancel" }));
  const endedAt = t.at();
  assert.equal(t.adapter.nextWake(t.state), endedAt + 20_000);
  t.wait(19_000);
  t.settle("a", "b");
  assert.equal(t.view("a").status, "cancelled");
  t.wait(1000);
  t.settle("a", "b");
  assert.equal(t.view("a").status, "lobby");
  assert.deepEqual(t.view("a").players.map((p) => p.id), ["a", "b"]);
  assert.equal(t.view("a").legal.start, true);
});

test("an idle lobby is emptied and an absent person is dropped from a lobby", () => {
  const w = world();
  w.join("a", "Ada");
  w.join("b", "Bea");
  w.wait(61_000);
  w.settle("a");
  assert.deepEqual(w.adapter.members(w.state), [{ id: "a", name: "Ada" }, { id: "b", name: "Bea" }].filter((m) => m.id === "a"));
  w.wait(61_000);
  w.state = w.adapter.advance(w.state, w.deps).state;
  assert.deepEqual(w.adapter.members(w.state), [], "nobody left who is a person");
  const live = world();
  live.join("a", "Ada");
  live.state = live.adapter.presence(live.state, { type: "live-members", ids: ["a"] }, live.deps).state;
  live.wait(10 * 60_000);
  live.state = live.adapter.advance(live.state, live.deps).state;
  assert.equal(live.adapter.members(live.state).length, 1, "a live connection keeps the seat");
  live.wait(30 * 60_000);
  live.state = live.adapter.advance(live.state, live.deps).state;
  assert.equal(live.adapter.members(live.state).length, 0, "stale lobby emptied");
});

test("a game's own refusal codes are all representable: unknownPlayer and notEnoughPlayers pass through, others become notAllowed", () => {
  const w = world();
  w.startTwo();
  const first = w.view("a").round!.actorId!;
  for (const [n, expected, status] of [[99, "unknownPlayer", 422], [98, "notEnoughPlayers", 422], [97, "notAllowed", 422]] as const) {
    const r = w.act(first, { type: "add", n });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, expected);
      assert.equal(r.error.status, status);
      assert.ok(r.error.message.length > 0);
    }
  }
  assert.ok(ERROR_CODES.includes("unknownPlayer"));
  assert.equal(asErrorCode("roomFull"), "roomFull");
  assert.equal(asErrorCode("anything else"), "notAllowed");
});

test("the host's pause passes the time to presence", () => {
  const w = world();
  w.startTwo();
  winRound(w, "a", false);
  const at = w.at();
  ok(w.act("a", { type: "pause" }));
  assert.equal(w.state.presence.manualAt, at);
  ok(w.act("a", { type: "resume" }));
  assert.equal(w.state.presence.manualAt, null);
});

test("without computer-players the table still runs: addBot is refused and not offered, nothing is filled", () => {
  const w = world({ noComputers: true });
  w.join("a", "Ada");
  w.join("b", "Bea");
  assert.equal(w.view("a").legal.addBot, false);
  assert.equal(code(w.act("a", { type: "addBot" })), "notAllowed");
  ok(w.act("a", { type: "start" }));
  assert.equal(w.adapter.members(w.state).length, 2);
  assert.equal(w.view("a").status, "running");
  const actor = w.view("a").round!.actorId!;
  ok(w.act(actor, { type: "add", n: 1 }));
  assert.equal(w.adapter.advance(w.state, w.deps).changed, false);
  winRound(w, "a");
  assert.equal(w.view("a").history.length, 1);
  assert.equal(w.parts.computers, undefined);
});

test("the visual definition marks the computer-players input not required and the others required", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path: string) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
  const inputs = read("visual/definition.json").ports.filter((p: { direction: string }) => p.direction === "input");
  for (const port of inputs) assert.equal(port.required, port.id !== "computer-players", port.id);
});

test("the level clock runs only while no rebuy offer is open, as the tournament says", () => {
  const w = world({ rebuys: true });
  w.startTwo();
  const runs: boolean[] = [];
  const advance = w.parts.clock.advance;
  w.parts.clock.advance = (c, now, r) => { runs.push(r.level); return advance(c, now, r); };
  winRound(w, "a");
  winRound(w, "a");
  winRound(w, "a", false);
  w.wait(5000);
  w.settle("a", "b");
  assert.equal(w.view("a").phase, "offers");
  runs.length = 0;
  w.wait(1000);
  w.settle("a", "b");
  assert.ok(runs.length > 0 && runs.every((r) => r === false), "level clock frozen during the offer");
  ok(w.act("b", { type: "rebuy", accept: true }));
  runs.length = 0;
  w.wait(1000);
  w.settle("a", "b");
  assert.ok(runs.length > 0 && runs.every((r) => r === true), "level clock runs again once the offer is answered");
});

// Play one whole round so that `winner` takes the pot, then let the result pause pass.
function winRound(w: ReturnType<typeof world>, winner: string, hold = true) {
  const ids = ["a", "b"];
  for (let i = 0; i < 6 && w.view("a").phase === "acting"; i++) {
    const actor = w.view("a").round!.actorId!;
    ok(w.act(actor, { type: "add", n: actor === winner ? 2 : 1 }));
  }
  w.wait(1000);
  w.settle(...ids);
  assert.equal(w.view("a").phase, "over");
  if (hold) {
    w.wait(5000);
    w.settle(...ids);
  }
}
const stacks = (w: ReturnType<typeof world>) => Object.fromEntries(w.view("a").players.map((p) => [p.id, p.stack]));

test("rebuy offers: offered, taken, then eliminated; places, winner and the end", () => {
  const w = world({ rebuys: true });
  w.startTwo();
  winRound(w, "a");
  winRound(w, "a");
  winRound(w, "a", false);
  assert.equal(stacks(w).b, 0);
  assert.equal(stacks(w).a, 2 * START_STACK, "chips are conserved: a holds both starting stacks");
  w.wait(5000);
  w.settle("a", "b");
  let v = w.view("a");
  assert.equal(v.phase, "offers");
  assert.deepEqual(v.rebuyOffers, [{ playerId: "b", remainingMs: 30_000 }]);
  assert.equal(v.legal.rebuy, false);
  assert.equal(v.promptKey, "rebuyWaiting");
  assert.equal(w.view("b").legal.rebuy, true);
  assert.equal(w.view("b").promptKey, "rebuyOffer");
  assert.equal(code(w.act("a", { type: "rebuy", accept: true })), "notAllowed");
  assert.equal(code(w.act("a", { type: "add", n: 1 })), "wrongPhase");
  const level = w.state.clock.level;
  w.wait(10_000);
  w.settle("a", "b");
  assert.equal(w.state.clock.level, level, "the level clock stands still while an offer is open");
  assert.equal(w.view("a").rebuyOffers[0].remainingMs, 20_000);
  ok(w.act("b", { type: "rebuy", accept: true }));
  v = w.view("a");
  assert.equal(v.phase, "acting");
  assert.equal(v.round!.no, 4);
  assert.equal(v.players.find((p) => p.id === "b")!.rebuysUsed, 1);
  assert.equal(v.players.find((p) => p.id === "b")!.stack, START_STACK - ANTE, "the rebuy stack less the ante");
  winRound(w, "a");
  winRound(w, "a");
  winRound(w, "a", false);
  w.wait(5000);
  w.settle("a", "b");
  assert.equal(w.view("a").rebuyOffers.length, 0, "only one rebuy per person");
  v = w.view("a");
  assert.equal(v.status, "completed");
  assert.equal(v.winnerId, "a");
  assert.equal(v.promptKey, "champion");
  assert.deepEqual(v.players.map((p) => [p.id, p.place, p.status]), [["a", 1, "in"], ["b", 2, "out"]]);
  assert.equal(v.legal.newGame, true);
  assert.equal(w.view("b").legal.newGame, true);
});

test("a rebuy offer that is not answered is declined at the deadline", () => {
  const w = world({ rebuys: true });
  w.startTwo();
  winRound(w, "a");
  winRound(w, "a");
  winRound(w, "a", false);
  w.wait(5000);
  w.settle("a", "b");
  assert.equal(w.view("a").phase, "offers");
  assert.equal(w.adapter.nextWake(w.state), w.at() + 30_000);
  w.wait(29_999);
  w.settle("a", "b");
  assert.equal(w.view("a").phase, "offers");
  w.wait(1);
  w.settle("a", "b");
  assert.equal(w.view("a").status, "completed");
  assert.equal(w.view("a").players.find((p) => p.id === "b")!.place, 2);
});

test("a computer takes its rebuy after the delay without being asked", () => {
  const w = world({ rebuys: true });
  w.join("a", "Ada");
  ok(w.act("a", { type: "addBot" }));
  ok(w.act("a", { type: "start" }));
  const bot = "computer-ann";
  const total = () => (w.view("a").game as { total: number }).total;
  // The person always wins: take 2 to finish, otherwise 2 on an empty count and 1 on a count of 1.
  const playRound = () => {
    for (let k = 0; k < 12 && w.view("a").phase === "acting"; k++) {
      if (w.view("a").round!.actorId === "a") ok(w.act("a", { type: "add", n: total() + 2 >= TARGET || total() === 0 ? 2 : 1 }));
      else { w.wait(5000); w.settle("a"); }
    }
    w.wait(1000);
    w.settle("a");
    w.wait(5000);
    w.settle("a");
  };
  playRound();
  playRound();
  playRound();
  let v = w.view("a");
  assert.equal(v.phase, "offers");
  assert.equal(v.players.find((p) => p.id === bot)!.stack, 0);
  assert.deepEqual(v.rebuyOffers.map((o) => o.playerId), [bot]);
  w.wait(3999);
  w.settle("a");
  assert.equal(w.view("a").phase, "offers", "not before the delay");
  w.wait(1);
  w.settle("a");
  v = w.view("a");
  assert.equal(v.phase, "acting", "the computer accepted and the next round was dealt");
  assert.equal(v.players.find((p) => p.id === bot)!.rebuysUsed, 1);
});

test("the champion is shown for the standings time and then the room is a lobby again", () => {
  const w = world();
  w.startTwo();
  winRound(w, "a");
  winRound(w, "a");
  winRound(w, "a", false);
  w.wait(5000);
  w.settle("a", "b");
  assert.equal(w.view("a").status, "completed");
  assert.equal(w.view("a").promptKey, "champion");
  w.wait(20_000);
  w.settle("a", "b");
  assert.equal(w.view("a").status, "lobby");
});

test("views: private records are redacted per viewer, displays see only what is shown, odds-style options are passed on", () => {
  const w = world();
  w.startTwo();
  const secret = (id: string | null, of: string) => (w.view(id).players.find((p) => p.id === of)!.game as { secret: number | null }).secret;
  assert.equal(typeof secret("a", "a"), "number");
  assert.equal(secret("a", "b"), null);
  assert.equal(secret("b", "a"), null);
  assert.equal(secret(null, "a"), null);
  assert.equal(w.view(null).display, true);
  assert.equal(w.view(null).you, "");
  assert.deepEqual(w.view(null).legal, { start: false, addBot: false, kick: false, leave: false, sitOut: false, return: false, rebuy: false, pause: false, resume: false, cancel: false, newGame: false, game: null });
  assert.equal((w.view("a", { hint: true }).game as { hint: number }).hint, TARGET);
  assert.equal((w.view("a").game as { hint: number | null }).hint, null);
  assert.equal(w.view("a").version, 7);
  assert.equal(w.view("a").roomId, "room");
  assert.equal(w.view("zz").promptKey, "watching");
  assert.equal(w.view("zz").legal.cancel, true);
  assert.equal(w.view(null).promptKey, "waitingFor");
  winRound(w, "a", false);
  assert.equal(typeof secret("b", "a"), "number", "revealed when the round is over");
});

test("restore accepts only this schema and shape; a saved state round-trips through JSON", () => {
  const w = world();
  w.startTwo();
  ok(w.act("a", { type: "add", n: 1 }));
  const saved = JSON.parse(JSON.stringify(w.state));
  assert.deepEqual(w.adapter.restore(saved, 1), w.state);
  assert.throws(() => w.adapter.restore(saved, 2), /Unsupported/);
  assert.throws(() => w.adapter.restore({ ...saved, status: "weird" }, 1), /Unsupported/);
  assert.throws(() => w.adapter.restore(null, 1), /Unsupported/);
  const resumed = { ...w, state: w.adapter.restore(saved, 1) };
  w.state = resumed.state;
  ok(w.act("b", { type: "add", n: 1 }));
});

test("the engine takes its decision time from rules-settings unless set, and the settle from its own settings", () => {
  const parts = makeParts({ decisionSeconds: 10 });
  const engine = createEngine(parts);
  const deps = { now: () => 0, rng: () => 0.5 };
  let g = engine.create(0);
  for (const [id, name] of [["a", "Ada"], ["b", "Bea"]]) {
    const r = engine.join(g, id, name, 0);
    assert.ok(r.ok);
    g = r.game;
  }
  const r = engine.apply(g, "a", { type: "start" }, deps);
  assert.ok(r.ok);
  assert.equal(engine.view(r.game, "a", {}, { version: 1, roomId: "r" }).round!.remainingMs, 14_000);
  const fast = createEngine(makeParts({ decisionSeconds: 10 }), { decisionSeconds: 5, settleMs: 0 });
  const r2 = fast.apply(g, "a", { type: "start" }, deps);
  assert.ok(r2.ok);
  assert.equal(fast.view(r2.game, "a", {}, { version: 1, roomId: "r" }).round!.remainingMs, 5000);
});

test("the example room-side script runs without poker", () => {
  const r = demo();
  assert.equal(r.phase, "over");
  assert.deepEqual(r.lastResult, { no: 1, winnerId: "a", pot: 2 * ANTE, total: TARGET });
  assert.deepEqual(r.stacks, [START_STACK - ANTE + 2 * ANTE, START_STACK - ANTE]);
  assert.ok(r.wakes.length >= 1);
});
