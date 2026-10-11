# Documentation

## Making and shipping worlds

The [user guide](guide/README.md), for people who want to build a game world with piedmont:

- [Running piedmont](guide/running.md): Docker or Kubernetes.
- [Creating worlds](guide/worlds.md), [Playing a world](guide/playing.md).
- [The editor](guide/editor.md), [Writing a game program](guide/programs.md),
  [Generating assets with AI](guide/assets-ai.md),
  [Driving the editor with an AI agent (MCP)](guide/mcp.md).
- [Deploying to Cloudflare](guide/cloudflare.md).

## Running the backend

[Operator references](deploy/README.md): [the Docker stack](deploy/docker.md) and
[Kubernetes with Helm](deploy/kubernetes.md).

## Working on piedmont

- [DEVELOPING.md](../DEVELOPING.md): set-up, the dev servers, the test gate, CI, the shared engine
  dependency, probes and the dev bridge.
- [AGENTS.md](../AGENTS.md): the rules for agents and people in this repository, and long tests
  against a real GPU.
- [Developer docs](dev/README.md): the engine's architecture, frames, terrain streaming, rendering,
  flora, roads, physics, traffic and the game layer, the bake, the services and performance.
- [Specs](dev/specs/README.md): the design notes, plans and handoffs the project was built from.
- [Project records](dev/project/): where the code came from and what proves the split.

Pages beside the code: [apps/game](../apps/game/README.md), [bake](../bake/README.md),
[services/worldeditor](../services/worldeditor/README.md) and its
[MCP reference](../services/worldeditor/MCP.md), [services/assetsvc](../services/assetsvc/README.md),
[services/overpass](../services/overpass/README.md), [services/recon](../services/recon/README.md),
[deploy](../deploy/README.md).
