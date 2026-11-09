// Not packaged. The counting game of tests/fakes/parts.ts, moving chips through the REAL
// chip-ledger operations (commit, settle, voidHand, stakeOf) instead of a fake ledger.
import type { GameRules, HiddenRecord } from "../implementation/server/parts.ts";

export const ANTE = 40;
export const TARGET = 5;

export type ChipOps = {
  commit(ledger: any, id: string, amount: number): { ledger: any; committed: number };
  settle(ledger: any, awards: { amount: number; eligible: string[]; winners: { id: string; amount: number }[] }[]): any;
  voidHand(ledger: any): any;
  stakeOf(ledger: any, id: string): { stack: number };
};

type Round = {
  no: number; level: number; ids: string[]; actor: string | null; total: number; phase: "play" | "reveal" | "over";
  pot: number; winner: string | null; moves: number; lastActor: string | null; secrets: Record<string, number>;
};
const clone = <T>(v: T): T => structuredClone(v);

export function makeCountingGame(chips: ChipOps): GameRules {
  return {
    optionNames: [],
    newRound({ no, level, players, carry }, ledger, rng) {
      let l = ledger;
      const ids = players.map((p) => p.id);
      const first = (carry as { first: number } | null)?.first ?? 0;
      let pot = 0;
      for (const id of ids) {
        const put = chips.commit(l, id, Math.min(ANTE, chips.stakeOf(l, id).stack));
        l = put.ledger;
        pot += put.committed;
      }
      const secrets = Object.fromEntries(ids.map((id) => [id, Math.floor(rng() * 1000)]));
      const round: Round = { no, level, ids, actor: ids[first % ids.length], total: 0, phase: "play", pot, winner: null, moves: 0, lastActor: null, secrets };
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
    act(r, ledger, id, move) {
      const round = clone(r as Round);
      if (round.phase !== "play") return { ok: false, code: "wrongPhase" };
      if (round.actor !== id) return { ok: false, code: "notYourTurn" };
      const n = (move as { n: number }).n;
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
      let l = ledger;
      if (round.phase === "reveal") {
        l = chips.settle(l, [{ amount: round.pot, eligible: round.ids, winners: [{ id: round.winner!, amount: round.pot }] }]);
        round.phase = "over";
      }
      return { round, ledger: l };
    },
    outcome(r) {
      const round = r as Round;
      return round.phase === "over"
        ? { holdMs: 5000, voided: false, result: { no: round.no, winnerId: round.winner, pot: round.pot }, historyEntry: { winners: [{ playerId: round.winner, amount: round.pot }] } }
        : null;
    },
    voidRound(r, ledger) {
      const round = clone(r as Round);
      const l = round.phase === "over" ? ledger : chips.voidHand(ledger);
      round.phase = "over";
      return { round, ledger: l, outcome: { holdMs: 0, voided: true, result: { no: round.no, voided: true }, historyEntry: {} } };
    },
    observation: (r, id) => ({ total: (r as Round).total, target: TARGET, me: id }),
    records(r): HiddenRecord[] {
      const round = r as Round;
      return round.ids.map((id) => ({ ownerId: id, open: { moves: round.moves }, hidden: { secret: round.secrets[id] }, revealed: round.phase === "over" ? { secret: true } : {} }));
    },
    publicView: (r) => ({ total: (r as Round).total, target: TARGET, pot: (r as Round).pot, phase: (r as Round).phase }),
    legal(r, viewerId, context) {
      const round = r as Round;
      return { add: round.phase === "play" && round.actor === viewerId && !context.paused ? [1, 2] : [] };
    },
    prompt: () => null,
  };
}

// The computer's strategy for the counting game: reach the target when it can, else add one.
export const countingStrategy = {
  newMemory: () => ({}),
  choose: (observation: unknown) => ({ n: (observation as { total: number }).total + 2 >= TARGET ? 2 : 1 }),
  observe: () => undefined,
};
