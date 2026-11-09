# Turn engine component

## Purpose and facilities
`turn-engine` is the game-independent part of the recipe's table engine, taken from `engine.ts` and `adapter.ts`. It runs the lifecycle (lobby, started, a cycle of rounds with rebuy offers between them, completed or cancelled, and back to a lobby), checks every action and answers with an error code, keeps turn order (the actor, a settle time, a decision countdown, acting for absent or timed-out players, computer moves), schedules everything that falls due (`advance`, `computerMove`, `nextWake`), builds the per-viewer view with legal actions and prompts, and exposes all of it as the GameAdapter that realtime-rooms calls. It contains no game rules, seating, clocks, presence tracking, chip accounting, tournament placing or computer play: each is injected, and a game plugs in through the `game-rules` interface.

Facilities: `lifecycle` (Lobby, start, round cycle, rebuy offers, completion, cancellation and a new lobby); `checked-actions` (Every wire action checked with an error code); `turn-order` (Whose turn, settle time, decision countdown, acting for absent players, computer moves); `scheduled-steps` (advance, due moves, nextWake); `game-adapter` (The 14-method GameAdapter for realtime-rooms, plus per-viewer views, legal actions and prompts).

## User inputs
Settings (all optional): `decisionSeconds` (empty reads the house rules `timing.decision_seconds`, then 30), `settleMs` (4000: the table settles this long after a deal or a move before the countdown starts), `staleMinutes` (30: an idle lobby or ended table is emptied; a table paused with nobody connected is cancelled), `standingsSeconds` (20: standings stay up after the end) and `lobbyDropSeconds` (60: a lobby seat whose person has not been heard from is given up).

- `decisionSeconds` (integer; optional)
- `settleMs` (integer; optional; default `4000`)
- `staleMinutes` (integer; optional; default `30`)
- `standingsSeconds` (integer; optional; default `20`)
- `lobbyDropSeconds` (integer; optional; default `60`)

## Artefacts and dependencies
`component.json` maps every `implementation/` source into `components/turn-engine/`:

- `implementation/server/adapter.ts` -> `components/turn-engine/server/adapter.ts`
- `implementation/server/engine.ts` -> `components/turn-engine/server/engine.ts`
- `implementation/server/no-computers.ts` -> `components/turn-engine/server/no-computers.ts`
- `implementation/server/parts.ts` -> `components/turn-engine/server/parts.ts`

Dependencies: none.
`tools.lock.json` pins verification tools: node 26.5.0. Licence wording remains deferred.

## Provided interfaces
- `interfaces/game-adapter.json` defines `game-adapter` (ae/game-adapter) version 1.0.0.

## Required interfaces
- `game-rules` (ae/game-rules) version 1.0.0, supplied by the recipe or application.
- `seating` (ae/seating) version 1.0.0, supplied by the recipe or application.
- `game-clock` (ae/game-clock) version 1.0.0, supplied by the recipe or application.
- `private-views` (ae/private-views) version 1.0.0, supplied by the recipe or application.
- `presence` (ae/presence) version 1.0.0, supplied by the recipe or application.
- `tournament` (ae/tournament) version 1.0.0, supplied by the recipe or application.
- `computer-players` (ae/computer-players) version 1.0.0, supplied by the recipe or application (optional; may stay unconnected).
- `round-history` (ae/round-history) version 1.0.0, supplied by the recipe or application.
- `rules-settings` (ae/rules-settings) version 1.0.0, supplied by the recipe or application.

## Integration
Build the adapter with `createGameAdapter(parts, settings)` from `implementation/server/adapter.ts`, where `parts` (`implementation/server/parts.ts`) holds one component for each required interface: `{rules, seating, clock, views, presence, tournament, computers, history, settings}`. `computers` may be left out: the engine then uses `implementation/server/no-computers.ts` (nobody plays for a computer, `addBot` is refused and not offered, no seat is filled). The manifest marks the `computer-players` requirement `optional: true`, so a design without computer players leaves it unconnected and the engine runs on this stand-in. Hand the adapter to `createRoomClass` from realtime-rooms. Wire actions: `start`, `addBot`, `kick`, `leave`, `sitOut`, `return`, `pause`, `resume`, `cancel`, `newGame`, `rebuy`, plus any move `game-rules.parseMove` accepts. The view carries `players` (each with the game's redacted record), `round`, `game` (the game's own public view), `legal` (engine actions and the game's legal moves), `prompt`, `rebuyOffers`, `holds` and `history`. The engine state is JSON-serialisable and every call is pure. Error codes (all answered with HTTP status 400, 409 or 422): `badName badRequest roomFull staleVersion badToken notYourTurn wrongPhase notEnoughPlayers badAmount badTarget notAllowed paused unknownPlayer`; a code a game reports that is not in this list (`asErrorCode` in `engine.ts`) is sent as `notAllowed`, so every refusal holdem-rules can give (`unknownPlayer`, `notEnoughPlayers` included) is representable. The engine decides which clocks run: the action clock runs unless the table is paused or held, and the level clock also stops while `tournament.levelClockRuns(t)` is false (a rebuy offer is open); both are passed to game-clock `advance(clock, now, {action, level})`. `presence.setManualPause(state, on, now)` receives the time.

## Visual definition and connected examples
`visual/definition.json` maps its ports to the provided and required interfaces. `visual/examples/connected.json` connects the component to an illustrative application consumer. Both image formats and a text description are retained under `visual/output/`.

## Infrastructure
No service is deployed. The room (realtime-rooms) stores the state and sets the alarm from `nextWake`. No accounts or keys.

## Verification
`node --test tests/web.test.ts` runs the whole adapter against a trivial two-player counting game and small fakes for every required interface (`tests/fakes/parts.ts`, no poker): joining and names, start rules, computers, turn order and every error code, countdowns, acting for absent players and for sat-out players who return, computer pacing, automatic steps and result pauses, `nextWake`, manual and automatic pauses, holds, leaving and returning, cancellation (including by a watcher), the end and the new lobby, stale lobbies, rebuy offers taken, declined and timed out, computer rebuys, views and redaction, restore, settings and the runnable consumer. The suite also checks every refusal code a game may give, that the pause passes the time to presence, a table with no computer-players part, and that the level clock is frozen exactly while a rebuy offer is open. `authoring/integration.test.ts` (not packaged) runs the engine with the real seating, tournament and computer-players components. `authoring/integration-real.test.ts` (not packaged) plays a complete scripted counting-game tournament and, when holdem-rules offers the game-rules operations, a full poker hand, over the real implementation of every required component; a provider missing declared operations makes it skip with the list (`FILL_GAPS_WITH_FAKES=1` fills such a gap with the test fakes).

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5.0)

## Scenarios and presentation
Two people and a computer sit; the host starts; a counting game is played one move at a time; the loser of enough rounds is offered a rebuy, declines by silence, and the other is crowned; thirty seconds later the room is a lobby again. A person's connection drops mid-round: the table keeps running, the person is acted for when their countdown ends, and their next turns are acted for as soon as the settle ends. The host goes away between rounds: everything pauses until the host is back.

## Updates and removal
Patch updates replace files. The saved game state carries `schema: 1`; `restore` refuses anything else. Removal deletes the owned sources and the application's imports; stored room state stays in the room's own storage.
