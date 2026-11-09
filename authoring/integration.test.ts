// Not packaged. Wires the REAL seating, tournament and computer-players components (siblings in
// components/) into the turn engine, with the test fakes for everything else, to prove the
// interfaces fit. Run: node --test authoring/integration.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createSeating } from "../../seating/implementation/server/seating.ts";
import { createTournament } from "../../tournament/implementation/server/tournament.ts";
import { createComputers } from "../../computer-players/implementation/server/computers.ts";
import { createGameAdapter, type Deps } from "../implementation/server/adapter.ts";
import { clock, history, makeParts, presence, rules, settingsFrom, views, TARGET } from "../tests/fakes/parts.ts";

const identity = { validName: (n: unknown) => typeof n === "string" && /^[A-Za-z ]{1,20}$/.test(n) && n.trim() === n };
const seating = createSeating({ minimumPlayers: 2, maximumPlayers: 3 }, identity);
const ledger = {
  create: () => ({ balances: {} as Record<string, number>, issued: 0 }),
  issue(l: unknown, id: string, n: number) { const g = structuredClone(l as { balances: Record<string, number>; issued: number }); g.balances[id] = (g.balances[id] ?? 0) + n; g.issued += n; return g; },
  balance: (l: unknown, id: string) => (l as { balances: Record<string, number> }).balances[id] ?? 0,
  issued: (l: unknown) => (l as { issued: number }).issued,
  setSeats: (l: unknown) => l,
};
const schedule = { levelAt: (ms: number) => Math.floor(ms / 600_000) + 1, describe: (ms: number) => ({ level: Math.floor(ms / 600_000) + 1 }) };
const tournament = createTournament({ startingStack: 100, rebuyStack: 100 }, { ledger, schedule, seating });
const strategy = {
  newMemory: () => ({}),
  choose: (o: unknown) => ({ n: (o as { total: number }).total + 2 >= TARGET ? 2 : 1 }),
  observe: () => undefined,
};
const computers = createComputers({ names: ["Ann", "Bob"], mode: "fill-empty" }, { strategy, clock, seating });
const parts = { ...makeParts(), seating, tournament, computers, presence, views, history, settings: settingsFrom(), clock, rules };

test("the real seating, tournament and computer-players run a table through the engine", () => {
  const adapter = createGameAdapter(parts as never);
  let time = 0;
  const deps: Deps = { now: () => time, rng: () => 0.9, newId: () => "x" };
  let s = adapter.create(0);
  const j = adapter.join(s, "a", "Ada", false, deps);
  assert.ok(j.ok);
  s = j.value.state;
  const act = (id: string, body: unknown) => { const p = adapter.parseAction(body); assert.ok(p.ok); const r = adapter.apply(s, { id, role: "player" }, p.value.action, deps); assert.ok(r.ok, JSON.stringify(r)); s = r.value; };
  act("a", { type: "addBot" });
  assert.deepEqual(adapter.members(s).map((m) => m.name), ["Ada", "Ann"]);
  act("a", { type: "start" });
  assert.deepEqual(adapter.members(s).map((m) => m.name), ["Ada", "Ann", "Bob"], "fill-empty added the third");
  const view = () => adapter.view(s, { id: "a", role: "player" }, {}, { version: 1, roomId: "r" });
  assert.equal(view().status, "running");
  assert.equal(view().players.length, 3);
  for (let i = 0; i < 60 && view().status === "running"; i++) {
    const v = view();
    if (v.round?.stage === "acting" && v.round.actorId === "a") act("a", { type: "add", n: 1 });
    else { const at = adapter.nextWake(s); assert.notEqual(at, null); time = Math.max(time, at!); s = adapter.presence(s, { type: "request-seen", id: "a" }, deps).state; s = adapter.advance(s, deps).state; }
  }
  const end = view();
  assert.ok(end.history.length >= 1);
  assert.equal(end.status, "completed", "the table plays itself to a winner");
  assert.equal(end.players.reduce((n, p) => n + p.stack, 0), tournament.chipsIssued(s.tournament), "chips are conserved");
  assert.deepEqual(end.players.filter((p) => p.place === 1).length, 1);
});

test("mode fill-empty on start with the real components seats computers up to maximumPlayers", () => {
  const adapter = createGameAdapter(parts as never);
  const deps: Deps = { now: () => 0, rng: () => 0.9, newId: () => "x" };
  let s = adapter.create(0);
  const j = adapter.join(s, "a", "Ada", false, deps);
  assert.ok(j.ok);
  s = j.value.state;
  const r = adapter.apply(s, { id: "a", role: "player" }, { type: "start" }, deps);
  assert.ok(r.ok);
  assert.deepEqual(adapter.members(r.value).map((m) => m.name), ["Ada", "Ann", "Bob"]);
});
