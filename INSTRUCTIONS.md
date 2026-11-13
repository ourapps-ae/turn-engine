# Turn engine instructions

## For the agent
Select `ourapps-ae/turn-engine` once per recipe. Connect `game-rules` to the game (holdem-rules for poker), and `seating`, `game-clock`, `private-views`, `presence`, `tournament`, `computer-players`, `round-history` and `rules-settings` to those components; connect the provided `game-adapter` to realtime-rooms' `game` requirement. Leave `decisionSeconds` empty unless the recipe sets it outside the house rules. `computer-players` is an optional requirement: a recipe without computer players leaves it unconnected, and in code `parts.computers` is left out (the engine then uses the no-computers stand-in). Connect it when computer players are wanted. The engine passes game-clock `advance` the flags `{action, level}`: the level clock stops while `tournament.levelClockRuns` is false, so blind levels do not run during a rebuy decision.

- Select package `ourapps-ae/turn-engine` version `0.6.0`.
- Settings to configure:
  - `decisionSeconds` (integer; optional)
  - `settleMs` (integer; optional; default `4000`)
  - `staleMinutes` (integer; optional; default `30`)
  - `standingsSeconds` (integer; optional; default `20`)
  - `lobbyDropSeconds` (integer; optional; default `60`)
- Connect the provided `game-adapter` (ae/game-adapter 1.0.0) to the consumer that needs it.
- Supply `game-rules` (ae/game-rules 1.0.0) from the component that provides it.
- Supply `seating` (ae/seating 1.0.0) from the component that provides it.
- Supply `game-clock` (ae/game-clock 1.0.0) from the component that provides it.
- Supply `private-views` (ae/private-views 1.0.0) from the component that provides it.
- Supply `presence` (ae/presence 1.0.0) from the component that provides it.
- Supply `tournament` (ae/tournament 1.0.0) from the component that provides it.
- Optionally supply `computer-players` (ae/computer-players 1.0.0) from the component that provides it; leave it unconnected for a table without computers.
- Supply `round-history` (ae/round-history 1.0.0) from the component that provides it.
- Supply `rules-settings` (ae/rules-settings 1.0.0) from the component that provides it.
- No accounts or keys are needed.

## For the developer
Nothing to supply: no accounts or keys. Write one `createGameAdapter(parts)` call in your server entry with the components you selected, and pass it to `createRoomClass`. A new game needs only a `game-rules` implementation; the lobby, rebuys, pausing, presence and computer play come from the other components. To check it works, run the commands below. Provider shapes: `tournament` takes chip-ledger as `create/issue/balance/issued/setSeats` (`createLedgerApi(settings)`) and level-schedule as `levelAt/describe` (`createScheduleApi(schedule)`). To check the whole stack, run `node --test authoring/integration-real.test.ts` in the repository (not packaged); it names every provider that lacks a declared operation.

## How to check
From the component directory:

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5)
- `python3 -m aepm review <digest> --store STORE --policy POLICY --trusted --allow-network` checks an archive fetched with `python3 -m aepm fetch ourapps-ae/turn-engine@VERSION --store STORE --from https://ourapps.app` and runs its suites.
