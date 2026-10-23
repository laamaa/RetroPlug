// Risa identification gates its Songs menu and warms a cold ROM before audio
// handoff. Restored savestates keep their exact CPU/audio position.
import { z } from "zod";
import type { RoleRegistry } from "./systemRoles";

export function registerRisaRole(registry: RoleRegistry): void {
  registry.registerRole({ kind: "risa", category: "feature", scope: "system", schema: z.object({}),
    // Finish the cold boot before handing the core to a DAW: an idle,
    // unarmed REAPER track may not process until Play. Never advance a restored state.
    onConstruct: (spec) => spec.stateBytes || spec.statePath ? spec : { ...spec, warmupMs: 2500 } });
}
