// Stands in for computer-players when none is connected: nobody plays for a computer, no computer
// can be added or seated, and the room's other behaviour is unchanged.
import type { ComputersApi } from "./parts.ts";

export const noComputers: ComputersApi = {
  create: () => ({}),
  forget: () => ({}),
  add: () => ({ ok: false, code: "notAllowed" }),
  idFor: (name) => "computer-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  fill: (seats) => ({ state: seats, added: [] }),
  actsFor: () => false,
  moveDeadline: (_clock, settleUntilMs) => settleUntilMs,
  isDue: () => false,
  rebuyDelayMs: () => 0,
  choose: (state) => ({ move: null, state }),
  observe: (state) => state,
};
