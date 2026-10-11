# Roads, lanes and signals

The roads are OpenStreetMap, measured against the lidar and drawn as splines with real widths. The
junction rules (who stops, where the signal stands, which phase runs) are **derived** from the
drawn network rather than transcribed, because suburban OSM records almost none of them.

## From OSM to a road network (bake)

`bake/piedmont_bake/osm.py` and `network.py`:

- **Identity:** a road is chained through shared end nodes by its `ref` (`I 70`, `MD 200`), else
  its `name`. Divided highways come out as two one-way chains. Ids are intrinsic,
  `r<smallest OSM way id in the chain>`, so adding or removing other chains never renumbers a road
  (a positional id once shifted 21 of 39 branch profiles onto the wrong roads).
- **The spine** is the world's primary road; every other chain is a **branch** with its junctions.
  `profile.json` and each branch's profile hold the road height every few metres from the lidar,
  the ground beside it (cut or fill) and the canopy.
- **Structures** are measured, not inferred: bridge-deck points (lidar class 17) within a few
  metres of the centreline whose deck continues the road's grade are a bridge you are on; planar
  undersides 4.5 to 40 m above the road are an overpass (or a gantry when short). OSM crossing tags
  are the cross-check.
- **Dead ends** are cul-de-sacs by default (a turning bulb sized by road class) unless OSM says
  `turning_circle`, or an author marks a true dead end (`dead_ends.json`). Driveways do not make a
  junction.
- **Lanes:** OSM `lanes` per way; a chain whose ways disagree keeps the set, and the viewer takes
  the smallest member (the through count) for a branch. The spine has per-station lane counts and
  tapers.

## Junction control (`bake/piedmont_bake/intersections.py`)

| Rule | Value | Why |
|---|---|---|
| one crossing per node cluster | 20 m | merges the node pair an offset crossroads is drawn as, never two real junctions |
| a junction at all | 3 or more approaches | two arms is one road OSM happened to split |
| a signal governs a crossing | within 40 m | signals stand on each arm's stop line |
| opposing arms share a phase | 180 ± 40° | tolerant of a skewed crossing |
| stop-line setback | max(6 m, half the widest cross street + 1.5 m) | keeps the bar off the cross street |

**Who stops: class first, continuity second.** When classes tie, the road that runs *through*
outranks the one that ends at it (a T: the stem stops). Only two equal roads that both run through
are a true crossroads. Arms are grouped by **route** (name, then ref), so the two carriageways of a
divided road are one road. A motorway carriageway never stops, and a junction where every arm is a
motorway or a motorway link is a merge or split, not a stop-controlled crossing. A junction left
with no stopper is `uncontrolled`.

**Signals:** exactly one phase is superior (the phase holding the superior road). Default timings
are 120 s for the major road, 20 s for the minor, plus 4 s amber and 2 s all-red; more than two
phase groups round-robin. Every approach gets a mast, not every OSM signal node.

**Street-name blades** go on one corner, chosen from four candidates in preference order, because
only the viewer knows where the asphalt ends. Truncation keeps the suffix ("Thistle Brooke Ct").

**Sidewalks** come from zones derived by buffering the residential network (`walkways.py`): a
subdivision closes into a zone, a rural road falls out. OSM wins where it has an answer
(`sidewalk=no`, a mapped footway nearby). An authored `sidewalk_zones.json` replaces the derivation.

## Drawing it (viewer)

| Module | What |
|---|---|
| `world/scene.ts` | the road splines (centripetal Catmull-Rom through the smoothed centreline), widths by lanes and class, the graded ground, branch building in chunks |
| `world/props.ts` | the road mesh split by surface class with real-scale UVs |
| `world/intersections.ts` | signals that cycle, stop bars, blades, lane arrows. The phase is a pure function of wall-clock time, so every client sees the same light |
| `world/furniture.ts` | masts, signs, kerbs, sidewalks, barriers. A pole is walked sideways from the node until it clears the asphalt |
| `world/structures.ts` | authored `flatten`, `suppress` and `bridge_over` intervals, applied before the spline is built |
| `world/overpass.ts` | grade separation: which carriageway the ground follows, and the deck colliders for the others |
| `game/traffic/signals-ecs.ts` | the signal controllers as entities the traffic reads: a fixed cycle by default; actuated and coordinated timing is the opt-in vocabulary |

The road-band frame (along-track metre `s`, signed lateral offset, positive to the left of travel)
is how anything attached to a road is stored, so a re-bake that moves the centreline sideways keeps a
bridge over the road. `apps/game/src/editor/author/roadband.ts` holds the conversions.

## Sign conventions that bite

- three `rotation.y = θ` sends local +Z to `(sin θ, 0, cos θ)`; with `θ = atan2(dir.x, dir.z)` local
  Z runs along the road and local X is the road's left normal.
- **Left of travel** for a world direction `dir` is `(dir.z, 0, −dir.x)`.
- A **compass bearing** is 0 at north (−Z) and 90 at east (+X). A placement's `yaw_deg` is a
  bearing, rendered as `rotation.y = −yaw·π/180`.
- `buildings[].rect.yaw_deg` is a **maths angle from east** describing an axis; aligning a box to a
  footprint is `yaw = −rect.yaw_deg`. Get it wrong and a town mirrors, plausibly.
- `profile.ground_rel`: positive means the ground is above the pavement (a cut).

## Known gaps

- Branches have no per-station lane counts yet (only the spine does), and nothing turns
  `turn:lanes` into turn-pocket geometry.
- A junction just outside a world's road query is missing from the graph; signals there fall back
  to a single mast.

The audit behind these, and the plans for furniture, are
[specs/LANES-AND-SIGNALS.md](specs/LANES-AND-SIGNALS.md),
[specs/PLAN-STREET-FURNITURE.md](specs/PLAN-STREET-FURNITURE.md) and
[specs/DESIGN.md](specs/DESIGN.md) (section 5, every detection rule with its threshold).
