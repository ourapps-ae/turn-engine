# Source mapping

Reference revision: `19905b75dbea89fbfd424d67fe26c81aaed0e018`. Extraction source: `OurPoker/recipe/` (read-only). Every function below takes its structure from the named lines; the poker facts (cards, blinds, betting, pots, odds) were removed and the other engine parts were replaced by injected interfaces.

- `implementation/server/engine.ts` <- `server/src/engine.ts`:
  - `newLobby` 143-165, `fail` 167, `Result` 141: `create`, `resetLobby`, `fail`; the poker `Game` fields became `EngineState` holding one slice per injected component.
  - `join` 208-221: `join` (name, phase, then seating). `validName` 179: seating via guest-identity.
  - `seen` 252-263, `setLive` 289-301, `away` 304-310, `setHold` 272-283: delegated to presence (`seen`, `setLive`, `away`, `setHold`); the engine keeps the guards (seat exists, computers excluded, `look` only once a round is over).
  - `apply` 312-324 and `step` 326-369: `apply`, `step` (every wire action and its error code).
  - `start` 371-409, `addBot` 413-419, `kick` 421-428, `leave` 432-445, `newGame` 447-452: `start`, the `addBot`, `kick`, `leave`, `newGame` cases.
  - `tick` 456-462, `refreshPauses` 464-479: `tick` (which clocks run), `refresh` (presence).
  - `advance` 483-509, `backToLobby` 513-520, `visible` 523-525: `advance`, `backToLobby`, `dropAbsentFromLobby`, `visible`.
  - `runDue` 527-529 and `dueStep` 532-571: `runDue`, `dueStep` (offers, between rounds, the actor's deadline with the "back, so full countdown" rule, automatic steps, result pause end).
  - `botDue` 574-579: `computerDue`; the bot move loop of `adapter.ts` `advance` 91-102: `computerMove` (strategy move, else the game's default move).
  - `nextWake` 582-608: `nextWake`.
  - `startHand` 625-705 (the part that is not poker: count the round, deal through the game, `afterAction` scheduling): `startRound`; `setActor` 833-839: `syncPhase`; `settle` 882-917 (the hold time, history entry, last result): `syncPhase` over-branch and `record`; `finishHand` 925-941: `finishRound`; `rebuy` 943-963: the `rebuy` case and `resolveOffer`; `afterOffers` 965-977: `afterOffers`.
  - `betting` 724-733 and `show` 1019-1025 (checked action, turn and phase codes): the `move` case with `needsTurn`.
  - `cancel` 1029-1034, `cancelByWatcher` 1037-1044, `doCancel` 1046-1068: `cancelByWatcher`, `doCancel`; voiding the round is the game's `voidRound`.
  - Left behind in the game (holdem-rules): `fullDeck`/`shuffle`, `postBlind`, `commitChips`, `autoAction` (now `defaultMove`), `act` 736-796, `afterAction` 799-820, `beginStreet`, `dealNext`, `startRunout`, `settle` pot awards, the deal pacing `DEAL_CARD_MS` and `SHOWDOWN_*`/`HAND_OVER_MS` hold times (now `RoundOutcome.holdMs`), `RUNOUT_STEP_MS` (now `autoDelayMs`), `chipsInPlay`. Left to other components: `eliminate`, `complete`, `completeBotsOnly` (tournament), pauses and presence timers `PRESENCE_MS` (presence), `END_MS`, `STALE_MS`, `LOBBY_DROP_MS` (now settings of this component).
  - View: `server/src/view.ts` `viewFor` 10-53, `phaseOf` 55-63, `legalFor` 177-219, `promptFor` 223-264, `ordinal` 266-270 became `view`, `phaseOf`, `legalFor`, `promptFor`, `ordinal`; the cards, hands, pots, odds and poker prompts (`handWon`, `yourTurnCall`, `runout`, ...) moved to `game-rules.publicView`, `legal`, `prompt`.
- `implementation/server/adapter.ts` <- `server/src/adapter.ts` (all 14 methods: `create` 20, `restore` 21-25, `options` 26, `members` 27, `summary` 28, `clearSpectators` 29, `join` 30-40, `parseAction` 41-53, `apply` 54-64, `presence` 65-83, `connection` 84-90, `advance` 91-102, `nextWake` 103, `view` 104-107), the error messages 10-13, and the types of `components/realtime-rooms/implementation/server/adapter.ts`. `options` and `connection` handle every name in `game-rules.optionNames` (the recipe handled only `odds`). `inviteUrl` and `updateUrl` (view 106) are not set: the room subclass adds them. Poker `Action` parsing 44-50 moved to `game-rules.parseMove`.
- `implementation/server/parts.ts` <- new: TypeScript types of the nine required interfaces (`computers` optional, `levelClockRuns`, `setManualPause(state, on, now)`, wider `MoveCode`).
- `implementation/server/no-computers.ts` <- new (`generated-platform`): the computer-players interface with nobody playing, for an engine built without `computers`.
- The `computer-players` requirement is `optional: true` in the manifest and the visual definition; `no-computers.ts` is the stand-in.
- Also in `engine.ts` and `adapter.ts` (new, no recipe line): `ERROR_CODES`, `asErrorCode` and the `unknownPlayer` code (the recipe had no game with codes of its own); `tick` reads `tournament.levelClockRuns` where `engine.ts` 456-462 tested `!hasOffers` inline; `legal.addBot` also asks `computers.add`.
- `interfaces/game-adapter.json`, `interfaces/required/*.json`, `examples/consumer.ts`, `tests/fakes/parts.ts` (a counting game and fakes), tests, `authoring/integration.test.ts`, `authoring/integration-real.test.ts`, `authoring/real-providers.ts`, `authoring/real-world.ts` and `authoring/counting-game.ts`: new.
