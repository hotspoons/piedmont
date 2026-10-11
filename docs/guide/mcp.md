# Driving the editor with an AI agent (MCP)

The world editor is also an [MCP](https://modelcontextprotocol.io) server. An agent such as Claude
Code, or anything else that speaks MCP over HTTP, can do through it what you do in the page: define
and bake worlds, write levels and programs, place things, generate assets, and deploy.

## Connect

Open **Settings → Agent** in the world editor. The **MCP: this editor as tools** section shows the
endpoint, the token and a ready-made configuration; **Copy configuration** copies it. It looks like
this:

```json
{
  "mcpServers": {
    "piedmont-world-editor": {
      "type": "http",
      "url": "https://<your editor>/api/agent/mcp",
      "headers": { "Authorization": "Bearer aat_…" }
    }
  }
}
```

Put it in your agent's MCP configuration (for Claude Code, a project's `.mcp.json`; keep that file
out of version control, since it holds the token). Copy it rather than retyping it.

**The token** is created on first start and kept on the editor's volume. In Settings → Agent you
can paste your own and **Save this token**, or **Regenerate** it, which immediately disconnects
every agent using the old one. Two settings control it:

| Setting | Effect |
|---|---|
| `PIEDMONT_EDITOR_MCP_TOKEN` | fix the token from the environment (for example from a Kubernetes Secret); the panel then shows it read-only |
| `PIEDMONT_EDITOR_MCP_AUTH` | `off` disables the token; anything else forces it on. By default it is on unless the editor's host is localhost |

If agents reach the editor by a different address than your browser does, set
`PIEDMONT_EDITOR_PUBLIC_URL` so the configuration shows the right URL.

## What it can do

Most tools run on the server and work with no browser open. They go through the same HTTP API the
page uses, so whatever an agent writes is validated exactly like an edit made by hand.

| Tools | What for |
|---|---|
| `world_*`, `run_bake`, `run_*` | list, preview, create, save, export and import worlds; bake, follow the log, cancel, publish |
| `osm_coverage`, `osm_regions`, `osm_import` | which Overpass instance covers what, and adding a Geofabrik region |
| `level_*`, `level_vocab`, `validate_level` | read, validate and save levels; the vocabulary a level and a program may use (weathers, profiles, HUD parts, setting ids, sound slots...) |
| `program_*`, `program_api`, `program_refs` | read and write programs; the full API declarations; everything a program can name in one world |
| `site_roads`, `site_road_polygon`, `site_road_gate`, `site_project`, `address_search` | the roads of a baked world in its own metres, a zone polygon along a road, a race gate across one, lat/lon to world metres, finding a road or address by name |
| `point_add`, `traffic_zone_add`, `course_save` | points, traffic zones and races |
| `vehicle_*`, `traffic_set_*` | vehicle builds and the traffic sets made from them |
| `catalog_*`, `model_list` | what can be placed |
| `asset_*`, `material_*` | AI generation: describe, draw, **view** a drawing (as an image), choose, mesh; textures as drafts to save or discard |
| `deploy_*` | plan and run a Cloudflare deploy, and its history |
| `splat_*`, `capture_*` | splat captures and training runs |
| `blender_*` | the editor's headless Blender: load, render, export, rig vehicles and characters |
| `editor_config`, `editor_ready`, `editor_version` | what this editor is pointed at, what is answering, and which build it is |
| `list_documents`, `read_document`, `write_document` | a world's authored JSON documents, directly |

A few tools need the world editor page open in a browser, because they run there:

- `code_check`, `code_outline`, `code_hover`, `code_definition`: the Program pane's TypeScript
  service, with the program API loaded;
- `shell_exec`, `shell_list`: the in-browser shell over the editor's documents;
- `editor_state`: what is open and selected right now.

They are listed only while a page is attached. One page holds the connection at a time; Settings →
Agent can take it over from another tab or person. Documents an agent changes are reloaded into
any open editor (unless that editor has unsaved edits, which it then tells you about).

## Tips for agents

- Read `program_api` before writing a program, and `level_vocab` before writing a level: nothing
  else lists what is allowed.
- `level_validate` returns every problem with a level, not just the first.
- `asset_view` is the only way for an agent to judge a drawing before spending a reconstruction on
  it.
- `editor_version` says which build answers; a program that type-checks against one build can fail
  on another.
- Use `site_road_polygon` and `site_road_gate` rather than computing coordinates: they work in the
  world's own frame, which is not latitude and longitude.

The complete reference, including how the page bridge works, is
[services/worldeditor/MCP.md](../../services/worldeditor/MCP.md).
