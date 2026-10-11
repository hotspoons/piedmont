#!/usr/bin/env node
// Writes services/overpass/osm-build-job.yaml: the Job the world editor creates for an osm-BUILD,
// rendered from the editor's own code (services/worldeditor/runs.mjs `osmBuildJob`) so the manifest
// an admin reviews cannot drift from the one that runs. A test (runs-osm.test.mjs) fails if it has.
//
//   node services/overpass/osm-build-job.mjs > services/overpass/osm-build-job.yaml

import { osmBuildJob } from '../worldeditor/runs.mjs'
import { renderYaml, manifest as importManifest } from './osm-import-job.mjs'

const HEADER = `# THE JOB AN OSM-BUILD CREATES, for review. GENERATED from services/worldeditor/runs.mjs
# (osmBuildJob) by services/overpass/osm-build-job.mjs; a test fails if the two differ.
#
# An osm-build is an osm-import (\`osm-import-job.yaml\`) with a DRAWN AREA instead of a named
# Geofabrik region: the same image, node, volume, ConfigMap and script (/opt/regions/import.sh), so
# the instance's \`regions\` sidecar applies the change through the dispatcher exactly as for an
# import. What differs is how import.sh learns the area:
#   * POLYGON_POLY_B64 is the ring a person drew in the editor, as an osmium .poly file, base64 so
#     it survives an env var. import.sh decodes it to /db/regions/<id>/region.poly, the region's
#     outline (what defer_deletes.py and the coverage map read);
#   * PBF_URLS is the Geofabrik extract(s) covering the ring, space-separated — chosen by the
#     editor's server, which holds the index geometry and the sizes (osmbuild.mjs). import.sh
#     downloads them, merges if there is more than one, and clips with \`osmium extract -p\`;
#   * there is NO updates stream: a drawn area is a snapshot (the extract it is cut from also
#     covers ground outside the shape), applied once and not followed.
#
# Example values: a small drawn patch on the \`overpass\` instance (gh200-1-node-2), covered by the
# Maryland extract. The editor fills in the polygon, the sources, the node and a unique name; a
# real build's ring is whatever a person drew. RBAC and the regions.enabled prerequisite are the
# same as osm-import-job.yaml.
`

/** The example, with `osmBuildJob` injected so a test can pass the one it imported. */
export function exampleJob(build = osmBuildJob) {
  return build({
    name: 'osm-build-overpass-example',
    runId: 'osm-build-overpass-build-a1b2c3-20261011120000-abcd',
    upstream: 'overpass',
    region: {
      region: 'overpass-build-my-patch-a1b2c3',
      name: 'my patch',
      polygon: [[-77.2, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.2, 38.8]],
      sources: [
        {
          id: 'us/maryland',
          name: 'us/maryland',
          pbf: 'https://download.geofabrik.de/north-america/us/maryland-latest.osm.pbf',
          updates: 'https://download.geofabrik.de/north-america/us/maryland-updates',
          bytes: 216000000,
        },
      ],
    },
    node: 'gh200-1-node-2',
    image: 'wiktorn/overpass-api@sha256:9bb5f4a9b54cd225bf828c04c67e7f4010650ff4d70b72157a9473a9ba02d93c',
  })
}

export const manifest = (build = osmBuildJob) => HEADER + renderYaml(exampleJob(build))

// keep the import manifest reachable from here too, so a caller has one place for both
export const importJobManifest = importManifest

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(manifest())
