// Not packaged. Builds the turn engine's parts from the REAL siblings in components/, each judged
// against what its consumer declares. `gaps` lists every declared operation a provider lacks; the
// tests skip (with that list) rather than fail while a provider has not landed.
import { join } from "node:path";
import { componentVersion, declaredOperations, describe, match, merged, COMPONENTS, type Match } from "./real-providers.ts";
import { createSeating } from "../../seating/implementation/server/seating.ts";
import { createTournament } from "../../tournament/implementation/server/tournament.ts";
import { createComputers } from "../../computer-players/implementation/server/computers.ts";
import { countingStrategy, makeCountingGame } from "./counting-game.ts";

export type Kind = "counting" | "poker";
export type Built = { gaps: string[]; matches: Match[]; notes: string[]; make?: (kind: Kind, options?: { fillComputers?: boolean }) => { parts: any; tournament: any; seating: any; rules: any } };

const RULES_FILE = join(COMPONENTS, "rules-settings", "tests", "fixtures", "texas-holdem-house-rules.json");
const SCHEMA_FILE = join(COMPONENTS, "rules-settings", "tests", "fixtures", "texas-holdem-house-rules.schema.json");

export const VERSIONS = ["holdem-rules", "game-clock", "presence", "private-views", "round-history", "chip-ledger", "level-schedule", "rules-settings", "poker-strategy", "guest-identity", "card-deck", "fair-shuffle", "seating", "tournament", "computer-players"];

export async function build(): Promise<Built> {
  const matches: Match[] = [];
  const gaps: string[] = [];
  const notes: string[] = [];
  const need = (m: Match, label = m.component) => {
    matches.push(m);
    if (!m.found) gaps.push(`${label}@${componentVersion(m.component)} lacks ${m.missing.join(", ")}`);
    return m;
  };

  const rulesSettings = await match("rules-settings", "rules-settings", declaredOperations("rules-settings"), (x) => {
    const rules = x.requireRules(RULES_FILE, SCHEMA_FILE, { strict: true });
    return [{ via: "createRulesSettings(requireRules(house rules fixture))", part: x.createRulesSettings(rules) }];
  });
  need(rulesSettings);
  const clock = need(await match("game-clock", "game-clock"));
  const views = need(await match("private-views", "private-views"));
  const presence = need(await match("presence", "presence"));
  const history = need(await match("round-history", "round-history"));
  const clockForComputers = await match("game-clock", "game-clock", ["elapsed", "wallAt"]);
  need(clockForComputers, "game-clock (computer-players: elapsed, wallAt)");
  const ledgerOps = ["create", "issue", "balance", "issued", "setSeats"];
  const chips = need(await match("chip-ledger", "chip-ledger", ledgerOps), "chip-ledger (tournament: create, issue, balance, issued, setSeats)");
  const handOps = ["stakeOf", "commit", "fold", "endRound", "returnUncalled", "buildPots", "displayPots", "awardPot", "settle", "voidHand", "nextHand", "validateSettings"];
  const chipsHand = need(await match("chip-ledger", "chip-ledger", handOps), "chip-ledger (holdem-rules: hand operations)");
  const deck = need(await match("card-deck", "card-deck", ["createShuffledDeck"]), "card-deck");
  const ranking = need(await match("poker-hand-ranking", "hand-ranking", ["evaluate", "compare", "compareEvaluations", "winners", "bestFive"], (x) => [{ via: "handRanking", part: x.handRanking }]), "poker-hand-ranking");
  const odds = await match("poker-odds", "poker-odds", ["winChance"], (x) => [{ via: "createOdds(handRanking)", part: x.createOdds(ranking.found ? ranking.part : x.handRanking) }]);
  need(odds, "poker-odds");
  const rules = rulesSettings.part ? (rulesSettings.part as { rules: unknown }).rules : null;
  const levels = await match("level-schedule", "level-schedule", ["levelAt", "describe", "levelInfo"], (x) => (rules ? [{ via: "createScheduleApi(scheduleFromRules(house rules))", part: x.createScheduleApi(x.scheduleFromRules(rules)) }] : []));
  need(levels, "level-schedule (tournament: levelAt, describe; holdem-rules: levelInfo)");
  const strategyOps = ["newMemory", "choose", "observe"];
  const strategy = await match("poker-strategy", "player-strategy", strategyOps, (x) => (odds.found ? [{ via: "createStrategy({odds})", part: x.createStrategy({ odds: odds.part }) }] : []));
  need(strategy, "poker-strategy (computer-players: newMemory, choose, observe)");
  const identity = need(await match("guest-identity", "guest-identity", ["validName", "createIdentityApi"]), "guest-identity");
  const holdem = await match("holdem-rules", "game-rules", declaredOperations("game-rules"), (x) =>
    ranking.found && chipsHand.found && deck.found && levels.found && rulesSettings.found
      ? [{ via: "createGameRules({ranking, ledger, deck, schedule, rules})", part: x.createGameRules({ ranking: ranking.part, ledger: merged(chipsHand.loaded), deck: merged(deck.loaded), schedule: levels.part, rules: rulesSettings.part }) }]
      : [],
  );
  need(holdem, "holdem-rules");

  const result: Built = { gaps, matches, notes };
  if (gaps.length) return result;

  result.make = (kind, options = {}) => {
    const ledgerModule = merged(chips.loaded);
    const guest = merged(identity.loaded);
    const seating = createSeating({ minimumPlayers: 2, maximumPlayers: 3, seating: "order" }, (guest as { createIdentityApi(settings: object): { validName(name: unknown): boolean } }).createIdentityApi({ nameMinLength: 1, nameMaxLength: 20 }));
    const stack = kind === "poker" ? 2000 : 100;
    const tournament = createTournament({ startingStack: stack, rebuyStack: stack, rebuysPerPlayer: 1, lastRebuyLevel: kind === "poker" ? 2 : 3, rebuyDecisionSeconds: 30 }, { ledger: ledgerModule as never, schedule: levels.part, seating });
    const computers = createComputers({ names: ["Ann"], mode: options.fillComputers === true ? "fill-empty" : "on-request" }, { strategy: kind === "poker" ? strategy.part : countingStrategy, clock: clockForComputers.part, seating: seating as never });
    const game = kind === "poker" ? holdem.part : makeCountingGame(ledgerModule as never);
    return { parts: { rules: game, seating, clock: clock.part, views: views.part, presence: presence.part, tournament, computers, history: history.part, settings: rulesSettings.part }, tournament, seating, rules: game };
  };
  return result;
}

export function report(built: Built): string[] {
  const lines = built.matches.map((m) => describe(m));
  for (const c of VERSIONS) lines.push(`VERSION ${c} ${componentVersion(c)}`);
  return lines;
}
