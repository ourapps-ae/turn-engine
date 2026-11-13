// The entry module of turn-engine's server code: everything code outside the component may use.
// `Deps` and `Result` are the adapter's; the engine's own are `EngineDeps` and `EngineResult`.
export * from "./adapter.ts";
export {
  DEFAULT_SETTINGS, ERROR_CODES, asErrorCode, checkSettings, createEngine,
  type Engine, type EngineAction, type EngineSettings, type EngineState, type ErrorCode, type Legal, type PlayerRow, type RoundView,
  type Schedule, type Slot, type Status, type View, type Deps as EngineDeps, type Result as EngineResult,
} from "./engine.ts";
export * from "./no-computers.ts";
export * from "./parts.ts";
