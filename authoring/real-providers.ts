// Not packaged. Finds the REAL implementation of every interface the turn engine requires, in the
// sibling components (../<component>/implementation/server/*.ts), and reports which declared
// operations (the Parts schema of interfaces/game-adapter.json) each one has.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const COMPONENTS = join(here, "..", "..");

export type Namespace = Record<string, unknown>;
export type Match = { component: string; port: string; part: any | null; found: boolean; missing: string[]; via: string; note: string; operations: string[] };

// The member of `Parts` (components.schemas.Parts in interfaces/game-adapter.json) that each required port fills.
const PART_OF_PORT: Record<string, string> = {
  "game-rules": "rules", seating: "seating", "game-clock": "clock", "private-views": "views", presence: "presence",
  tournament: "tournament", "computer-players": "computers", "round-history": "history", "rules-settings": "settings",
};

// The members the engine calls on a port's part, as its OpenRPC document declares them.
export function declaredOperations(port: string): string[] {
  const document = JSON.parse(readFileSync(join(here, "..", "interfaces", "game-adapter.json"), "utf8"));
  const schemas = document.components.schemas;
  let part = schemas.Parts.properties[PART_OF_PORT[port]];
  if (part?.$ref) part = schemas[part.$ref.split("/").pop()];
  if (!part) throw new Error(`no part declared for port ${port}`);
  return part.required;
}

export function componentVersion(component: string): string | null {
  const file = join(COMPONENTS, component, "component.json");
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")).identity.version;
  return Array.isArray(v) ? v.join(".") : String(v);
}

// Every .ts file under implementation/server, imported; files that fail to import are listed.
export async function loadServer(component: string): Promise<{ namespaces: { file: string; ns: Namespace }[]; errors: string[] }> {
  const dir = join(COMPONENTS, component, "implementation", "server");
  const namespaces: { file: string; ns: Namespace }[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { namespaces, errors: [`${component}: no implementation/server`] };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    try {
      namespaces.push({ file, ns: (await import(pathToFileURL(join(dir, file)).href)) as Namespace });
    } catch (e) {
      errors.push(`${component}/${file}: ${(e as Error).message}`);
    }
  }
  return { namespaces, errors };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Declared names that are readable properties, not functions (game-rules.optionNames).
const PROPERTIES = new Set(["optionNames"]);
const missingFrom = (part: unknown, operations: string[]) => operations.filter((op) => !(part && (PROPERTIES.has(op) ? Array.isArray((part as any)[op]) : typeof (part as any)[op] === "function")));

// Candidate "parts": the module itself, any exported object, any exported value of a created
// object, and what a zero-argument create/make/build function returns.
function candidates(namespaces: { file: string; ns: Namespace }[]): { via: string; part: any }[] {
  const out: { via: string; part: any }[] = [];
  for (const { file, ns } of namespaces) {
    out.push({ via: `${file} (module functions)`, part: ns });
    for (const [name, value] of Object.entries(ns)) if (isObject(value)) out.push({ via: `${file} export ${name}`, part: value });
    for (const [name, value] of Object.entries(ns)) {
      if (typeof value !== "function" || !/^(create|make|build)/.test(name)) continue;
      try {
        const made = (value as () => unknown)();
        if (isObject(made)) out.push({ via: `${file} ${name}()`, part: made });
      } catch {
        /* needs arguments: not discoverable without them */
      }
    }
  }
  return out;
}

// The merged functions of every module of a component, for code that calls them one by one.
export function merged(namespaces: { ns: Namespace }[]): Record<string, any> {
  const all: Record<string, unknown> = {};
  for (const { ns } of namespaces) Object.assign(all, ns);
  return all;
}

// `build` makes the component's parts from its exports when a factory needs arguments (for example
// createGameRules(deps)); each part it returns is judged against the declared operations too.
export type Build = (exports: Record<string, any>) => { via: string; part: any }[];

export async function match(component: string, port: string, operations = declaredOperations(port), build?: Build): Promise<Match & { loaded: { file: string; ns: Namespace }[] }> {
  const { namespaces, errors } = await loadServer(component);
  // Parts built with real arguments come first and win ties over zero-argument guesses.
  let options: { via: string; part: any }[] = [];
  if (build) {
    try {
      options = build(merged(namespaces));
    } catch (e) {
      errors.push(`${component} build: ${(e as Error).message}`);
    }
  }
  options.push(...candidates(namespaces));
  let best: { via: string; part: any; missing: string[] } | null = null;
  for (const c of options) {
    const missing = missingFrom(c.part, operations);
    if (best === null || missing.length < best.missing.length) best = { ...c, missing };
  }
  const found = best !== null && best.missing.length === 0;
  return {
    component, port, operations, loaded: namespaces, part: found ? best!.part : null, found, missing: best ? best.missing : operations,
    via: best ? best.via : "nothing importable", note: errors.join("; "),
  };
}

export function describe(m: Match): string {
  const version = componentVersion(m.component);
  return m.found ? `PROVIDER ${m.component}@${version} -> ${m.port}: all ${m.operations.length} declared operations present (${m.via})` : `PROVIDER ${m.component}@${version} -> ${m.port}: MISSING ${m.missing.join(", ")} (best candidate: ${m.via})${m.note ? " [" + m.note + "]" : ""}`;
}
