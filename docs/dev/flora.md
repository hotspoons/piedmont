# Trees, flora and canopy

Every tree in a world stands where the canopy model says a tree is, at the height it measured, and
is of a species the public record says grows there. This page covers the data (bake side) and the
drawing (viewer side).

## Where the trees come from

**Canopy height** is the backbone. Where lidar exists, the bake builds a canopy height model from
the classified point cloud: vegetation returns (or unassigned returns) minus the ground, 0 to 80 m,
zeroed over carriageways and under building footprints (`bake/piedmont_bake/lidar.py`,
`export.py`). Where lidar does not reach (outside the US, past a survey's edge), the Meta/WRI
global 1 m canopy-height model fills in (`canopy.py`, read straight from its public bucket).

**Species and ground cover** come from `bake/piedmont_bake/flora.py`:

```
LANDFIRE EVT class of every 30 m pixel               the spine: ~1000 named vegetation systems
  └─ species mix per class = f · (USFS FHP basal area over that class's pixels)
                           + (1 − f) · (the class name parsed against FIA's species list)
       f = the share of the class's pixels that carry any basal area
  └─ ground-cover class per class, by rule over LANDFIRE's lifeform, subclass and physiognomy
  └─ leaf cycle (evergreen, deciduous, annual) straight from the subclass
Daymet monthly climate at the site                   when it is green, never what it is
```

It is a blend rather than a threshold because both sources are data: LANDFIRE names a community
after its dominant tree, and FHP's basal area is dense in the East and sparse in the West. The
share `f` is reported per site as `canopy.coverage`.

The bake writes `flora.json`, a `flora` block in the manifest, and `flora_30m.png`, the class index
per 30 m pixel on its own lattice, so a tree on a canyon floor and one on the ridge above it can be
different species. Each species also gets `canopy_h_m`, the mean of this site's own lidar canopy
over the pixels where it carries basal area: that is what lets a 40 m stem in a redwood mix be a
redwood and an 8 m one a tanoak.

Bakes without a flora block fall back to an OSM land-use rule in the viewer.

## How the viewer draws them

| Module | What it does |
|---|---|
| `world/flora.ts` | reads the flora block: the class grid, `mixAt(x, y)`, `leafCycleAt`, seasonal curing |
| `world/species.ts` | genus → silhouette (spruce, fir, pine, redwood, cedar, hemlock, oak, poplar, willow...). The one place in this path where a judgement is written down, deliberately at the level of the genus, which is what a driver reads |
| `world/trees.ts` | near trees: procedural ez-tree models, scaled so the crown top lands on the measured height, re-assigned to the trees nearest the camera as it moves |
| `lod/impostors.ts` | far trees: the same models baked once to an 8-yaw atlas; each distant tree is one camera-facing quad, with a dither dissolve at the hand-over, so the switch is a change of technique, not of species |
| `lod/treeshadows.ts` | shadows past the near set, from impostor cards or invisible crowns |
| `world/treebudget.ts` | adapts the near-tree radius live: the cost of a wood is canopy fill, so it bounds the number of modelled trees near the eye (`TREE_ADAPT_*`) |
| `world/groundcover.ts` | eighteen ground classes (annual grassland, chaparral, conifer duff...), each a set of multipliers on the season palette, a blade style and a floor texture |
| `world/grass.ts` | grass and weeds: Bézier blades near the eye, sprite clumps further out, from a cache of 8 m world-aligned tiles generated a few per frame, each with its blades in random-rank order so any prefix is a uniform thinning |

Trees are planted from canopy cells (a cell of 3 m or more on a lattice, never within a few metres
of a pavement edge). Trunks collide (`PHYS_TREES`), queued nearest first so a replant does not
build hundreds of colliders in one frame.

**Where grass grows** is decided by the ground, not the photo: the strip paints the grass texture
by distance from the pavement, and the grass is planted on the same rule. Open ground only (low
canopy), off the pavement, mown short near the shoulder, taller with weeds further out, none on
steep slopes. Wind fades out when the camera moves fast. `lod/vegmask.ts` still streams an
excess-green mask from the imagery, now for diagnostics only.

Adjustment areas (Place → Areas) correct all of this per polygon: canopy scale and offset (baked
into the height model at load, so they change the tree list too), tree density (thinning only),
species, grass height and density, crop rows.

## Open work

- Chaparral and coastal scrub have no woody geometry yet; they draw as dense ground cover.
- Floor textures are painted per class with a recipe; the real sets belong to the texture pipeline
  (`pipelines/surfaces`).
- Alaska and Hawaii are wired for LANDFIRE but untested.

The full study, with every source evaluated, the readouts per site and the traps in each service,
is [specs/FLORA.md](specs/FLORA.md).
