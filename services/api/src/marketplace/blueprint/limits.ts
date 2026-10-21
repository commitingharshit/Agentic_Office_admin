// Hard bounds for an agent blueprint. The Python compiler (Task 2) enforces the same numbers and the shared
// conformance corpus (test/fixtures/blueprint-conformance) is what keeps the two in step.
export const BLUEPRINT_LIMITS = {
  maxBytes: 64 * 1024,        // blueprint.json
  maxSoulBytes: 32 * 1024,    // SOUL.md (checked by the package validator, Task 4)
  maxArray: 64,
  maxString: 2000,
  maxDepth: 8,                // the root object is depth 1
  maxKeys: 64,                // keys in one object
  maxNodes: 4096,             // values in the whole document
  maxTextBytes: 64 * 1024,
} as const;
