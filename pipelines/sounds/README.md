# sounds — the game's sound bank

`build.py` cuts the game's effects from CC0 recordings listed in `sources.json` (plus Rich's own
recordings in [`own/`](own/README.md)) into `apps/game/public/sounds/<slot>/`, and writes the bank's
manifest, `apps/game/public/sounds/bank.json`, and its per-file credits. The design — slots,
per-vehicle and per-actor overrides, what plays when — is [docs/SOUNDS.md](../../docs/SOUNDS.md).

```bash
python3 -m venv pipelines/sounds/.venv && pipelines/sounds/.venv/bin/pip install soundfile numpy
pipelines/sounds/.venv/bin/python -I pipelines/sounds/build.py            # everything
pipelines/sounds/.venv/bin/python -I pipelines/sounds/build.py gun.fire   # one slot
pipelines/sounds/.venv/bin/python -I pipelines/sounds/build.py --list     # the slots and their sources
```

Sources download once into `pipelines/sounds/.cache/` (gitignored); the cuts are committed.
