// A room's-eye use of the adapter without any poker: two people sit, the game (a counting game
// from the test fakes) is played to the end of the first round by waking the adapter when it asks.
import { createGameAdapter, type Deps } from "../implementation/server/adapter.ts";
import { makeParts } from "../tests/fakes/parts.ts";

export function demo() {
  const adapter = createGameAdapter(makeParts());
  let time = 0;
  const deps: Deps = { now: () => time, rng: () => 0.5, newId: () => "id" };
  let state = adapter.create(time);
  for (const [id, name] of [["a", "Ada"], ["b", "Bea"]]) {
    const r = adapter.join(state, id, name, false, deps);
    if (!r.ok) throw new Error(r.error.code);
    state = r.value.state;
  }
  const send = (id: string, body: unknown) => {
    const parsed = adapter.parseAction(body);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const r = adapter.apply(state, { id, role: "player" }, parsed.value.action, deps);
    if (!r.ok) throw new Error(r.error.code);
    state = r.value;
  };
  send("a", { type: "start" });
  send("a", { type: "add", n: 2 });
  send("b", { type: "add", n: 2 });
  send("a", { type: "add", n: 1 });
  const wakes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const at = adapter.nextWake(state);
    if (at === null) break;
    wakes.push(at);
    time = at;
    for (const id of ["a", "b"]) state = adapter.presence(state, { type: "request-seen", id }, deps).state;
    state = adapter.advance(state, deps).state;
    if (adapter.view(state, { id: "a", role: "player" }, {}, { version: 1, roomId: "r" }).phase === "over") break;
  }
  const view = adapter.view(state, { id: "a", role: "player" }, {}, { version: 1, roomId: "r" });
  return { phase: view.phase, wakes, lastResult: view.lastResult, stacks: view.players.map((p) => p.stack) };
}
