// Not packaged. Plays complete scripted games through the turn engine over the REAL implementation
// of every required component (siblings in components/, implementation/server/*.ts):
//   1. a counting game, moving chips through the real chip-ledger, to the end of a tournament
//      with a rebuy;
//   2. a full Texas hold'em hand (then more, to the end of the tournament) over holdem-rules.
// A provider that does not yet expose the operations a consumer declares makes the dependent
// tests skip with the list of what is missing. Run: node --test authoring/integration-real.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createGameAdapter, type Deps } from "../implementation/server/adapter.ts";
import { build, report, type Kind } from "./real-world.ts";

const built = await build();
for (const line of report(built)) console.log(line);
const skip = built.gaps.length ? `skipped: ${built.gaps.join("; ")}` : false;

// Reports (above) which providers matched; a gap is not a failure of this component, so it skips.
test("every real provider matches what its consumer declares", { skip }, () => {
  assert.deepEqual(built.gaps, []);
});

type Secret = { cards?: (string | null)[] | null; secret?: number | null } | null;

// Plays one tournament; `moveFor` chooses what the two people do when it is their turn.
async function play(kind: Kind, moveFor: (view: any, id: string) => unknown, limit: number) {
  const world = built.make!(kind);
  const clock = world.parts.clock;
  const adapter = createGameAdapter(world.parts as never);
  let time = 1_000_000;
  const deps: Deps = { now: () => time, rng: seeded(kind === "poker" ? 11 : 5), newId: () => "x" };
  const people = ["a", "b"];
  let s = adapter.create(time);
  for (const id of people) {
    const j = adapter.join(s, id, id === "a" ? "Ada" : "Bea", false, deps);
    assert.ok(j.ok, JSON.stringify(j));
    s = j.value.state;
  }
  const act = (id: string, body: unknown) => {
    const p = adapter.parseAction(body);
    assert.ok(p.ok, JSON.stringify(body));
    const r = adapter.apply(s, { id, role: "player" }, p.value.action, deps);
    return r.ok ? ((s = r.value), r) : r;
  };
  const must = (id: string, body: unknown) => {
    const r = act(id, body);
    assert.ok(r.ok, JSON.stringify([body, r]));
  };
  const view = (id: string | null) => adapter.view(s, id === null ? null : { id, role: "player" }, {}, { version: 1, roomId: "r" });
  must("a", { type: "addBot" });
  assert.deepEqual(adapter.members(s).map((m) => m.name), ["Ada", "Bea", "Ann"]);
  must("a", { type: "start" });
  assert.equal(view("a").status, "running");

  const seen = { hidden: false, shown: false, offer: false, rebuy: false, levelFrozen: true, rounds: 0, computerMoved: false, firstHand: null as any };
  const log: string[] = [];
  for (let i = 0; i < limit && view("a").status === "running"; i++) {
    for (const id of people) s = adapter.presence(s, { type: "request-seen", id }, deps).state;
    const v = view("a");
    if (seen.firstHand === null && v.history.length > 0) seen.firstHand = v.history[0];
    const info = (p: any): Secret => p?.game ?? null;
    const first = (r: Secret) => (r ? (r.cards ? r.cards[0] : r.secret) : undefined);
    const mine = v.players.find((p: any) => p.id === "a")!;
    const theirs = v.players.find((p: any) => p.id === "b")!;
    if (v.phase === "acting" && info(mine) && info(theirs)) {
      assert.notEqual(first(info(mine)), null, "you see your own hidden facts");
      seen.hidden ||= first(info(theirs)) === null;
    }
    if (v.phase === "over" && info(theirs) && first(info(theirs)) !== null && first(info(theirs)) !== undefined) seen.shown = seen.shown || kind === "counting";
    if (kind === "poker" && v.phase === "over" && v.lastResult) seen.shown ||= (v.lastResult as any).showdown !== null || (v.lastResult as any).uncontested === true;
    if (v.rebuyOffers.length > 0) {
      seen.offer = true;
      const level = clock.elapsed(s.clock, "level");
      const who = v.rebuyOffers[0].playerId;
      if (people.includes(who) && !seen.rebuy) {
        must(who, { type: "rebuy", accept: true });
        seen.rebuy = true;
        continue;
      }
      time += 1000;
      s = adapter.advance(s, deps).state;
      seen.levelFrozen &&= clock.elapsed(s.clock, "level") === level;
      continue;
    }
    if (v.phase === "acting" && people.includes(v.round!.actorId ?? "")) {
      const id = v.round!.actorId!;
      const body = moveFor(v, id);
      const r = act(id, body);
      if (!r.ok) must(id, kind === "poker" ? { type: v.legal.game?.check ? "check" : "fold" } : { type: "add", n: 1 });
      log.push(`${id}:${JSON.stringify(body)}`);
      continue;
    }
    if (v.round?.stage === "acting" && v.round.actorId === "computer-ann") {
      const before = JSON.stringify(s.slot?.round);
      const at = adapter.nextWake(s);
      time = Math.max(time + 1, at ?? time + 1);
      s = adapter.advance(s, deps).state;
      seen.computerMoved ||= JSON.stringify(s.slot?.round) !== before;
      continue;
    }
    const at = adapter.nextWake(s);
    assert.notEqual(at, null, "something is always scheduled while the game runs");
    time = Math.max(time + 1, at!);
    s = adapter.advance(s, deps).state;
  }
  return { world, adapter, s, view, seen, deps, time };
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("a complete counting-game tournament over every real provider", { skip }, async () => {
  const r = await play("counting", () => ({ type: "add", n: 1 }), 600);
  const end = r.view("a");
  assert.equal(end.status, "completed", "the table plays itself to a winner");
  assert.ok(end.history.length >= 1, "round-history recorded rounds");
  assert.ok(r.seen.hidden, "private-views hides another person's facts while the round is on");
  assert.ok(r.seen.offer && r.seen.rebuy, "a rebuy was offered and taken");
  assert.ok(r.seen.levelFrozen, "the level clock stood still while the offer was open");
  assert.equal(end.players.filter((p) => p.place === 1).length, 1);
  const issued = r.world.tournament.chipsIssued(r.s.tournament);
  assert.equal(end.players.reduce((n, p) => n + p.stack, 0), issued, "chips are conserved across rounds and the rebuy");
  assert.equal(r.adapter.view(r.adapter.restore(JSON.parse(JSON.stringify(r.s)), 1), null, {}, { version: 1, roomId: "r" }).status, "completed", "state survives a JSON round trip");
  const winners = end.history.flatMap((h: any) => h.winners ?? []);
  assert.ok(winners.length >= 1 && winners.every((w: any) => typeof w.playerId === "string" && w.amount > 0), "history entries carry winners from the game");
});

// Poker: check or call to the end of hand one, then push everything in until somebody wins.
const poker = (v: any, _id: string) => {
  const legal = v.legal.game;
  if (!legal) return { type: "fold" };
  if (v.round.no === 1) return legal.check ? { type: "check" } : legal.call !== null ? { type: "call" } : { type: "fold" };
  if (legal.bet) return { type: "bet", to: legal.bet.max };
  return legal.call !== null ? { type: "call" } : legal.check ? { type: "check" } : { type: "fold" };
};

test("a complete scripted poker hand, then a tournament to the end, over holdem-rules and every real provider", { skip }, async () => {
  const r = await play("poker", poker, 4000);
  const end = r.view("a");
  assert.equal(end.status, "completed", "the poker tournament plays itself to a champion");
  assert.ok(end.history.length >= 1);
  const first = r.seen.firstHand;
  assert.equal(first.no, 1);
  assert.ok(Array.isArray(first.winners) && first.winners.length >= 1 && first.voided === false, "hand one has winners in round-history");
  assert.equal(first.winners.reduce((n: number, w: any) => n + w.amount, 0) > 0, true);
  assert.ok((end.history.at(-1) as any).no >= 2, "later hands were played and recorded");
  assert.ok(r.seen.hidden, "hole cards are hidden from other viewers during play");
  assert.ok(r.seen.shown, "a showdown or an uncontested win was reported to clients");
  assert.ok(r.seen.computerMoved, "poker-strategy moved for the computer player");
  assert.equal(end.players.filter((p) => p.place === 1).length, 1);
  const issued = r.world.tournament.chipsIssued(r.s.tournament);
  assert.equal(end.players.reduce((n, p) => n + p.stack, 0), issued, "chips are conserved through every hand, pot and rebuy");
  assert.equal(r.adapter.view(r.adapter.restore(JSON.parse(JSON.stringify(r.s)), 1), null, {}, { version: 1, roomId: "r" }).status, "completed");
});
