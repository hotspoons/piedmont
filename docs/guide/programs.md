# Writing a game program

A **program** is the game logic of a level, written in TypeScript. The world gives you roads,
traffic zones, races, stunts, points and placements; the program decides what they mean: what the
goal is, what scores, when you win or lose.

Programs live in the editor, not in your repository: the **Program** mode lists them, edits them
with type checking and completion against the real API, and saves them to the install's volume.
A level runs a program when its `program` field names it (see [Stage: levels](editor.md#stage-levels)).

## The shape of a program

```ts
import { defineGame } from '@apex/program'

export default defineGame({
  setup(api) {
    api.score.currency('$')
    api.goal('Reach the finish before the traffic does')

    const finish = api.points().find((p) => p.kind === 'finish')
    if (finish) api.waypoint(finish, 'Finish')

    api.after(120, () => api.lose('Out of time'))
    api.each(() => {
      const me = api.player()
      if (me && finish && Math.hypot(me.x - finish.x, me.y - finish.y) < 15) {
        api.score.add(500, 'Delivered')
        api.win('Made it')
      }
    })
  },
})
```

`setup` runs once when the level starts (and again on **Restart**). `update(dt, api)`, if you
provide it, runs every frame; `api.each(fn)` in `setup` does the same and usually reads better.
Positions are metres in the world's own frame: `x` east, `y` north, `z` up.

**New file** in the Program pane creates a program from a working starter. The repository also has
a fuller starting point, [`apps/game/programs/skeleton.ts`](../../apps/game/programs/skeleton.ts):
it asks the world what it has (races, traffic zones, stunts, placements), does nothing when there
is nothing, and has a commented example of each kind of game (finish any race, a rally, rush hour,
a time limit, getting paid per hit, a race with a purse).

**The one rule worth keeping: never assume the world has anything.** A program is often dropped
onto several worlds. Ask (`api.races.ids()`, `api.traffic.ids()`, `api.points()`) and do
nothing gracefully when the answer is empty.

## In the Program pane

- **Check** type-checks against the API's real declarations.
- **Dry run** compiles the program, loads it and plays five seconds of it against a stub world,
  then reports what it did, including whether it would show a finish screen.
- **Save** (`⌘S` / `Ctrl+S`).
- **In this world** lists everything the selected world holds that a program can name (traffic
  zones, points, placements, stunts, races, the level's vehicles, sound slots, spawnable library
  items), each with a snippet that type-checks as inserted.
- Files can be organised in folders; a path like `lib/data.json` holds plain data.

## What the API covers

| Area | Calls | Comes from |
|---|---|---|
| messages and goals | `api.say(text)`, `api.goal(text)`, `api.waypoint(at, text)`, `api.mark(id, at)`, `api.objectives.set([...])` | |
| time and events | `api.each(fn)`, `api.after(s, fn)`, `api.every(s, fn)`, `api.when(cond, fn)`, `api.on('enters' \| 'leaves', zone, fn)` | |
| the player | `api.player()` (position, heading, speed), `api.facts()` (time, score, speed, distance), `api.ground(x, y)` | |
| points | `api.point(id)`, `api.points()` (each with its id, name, kind and position) | Place → Points |
| races | `api.races.ids()`, `.get(id)`, `.start(id)`, `.abandon()`, `.state()` | Place → Points → Courses |
| traffic | `api.traffic.ids()`, `.density(id)`, `.set(id, density, { over })`, `.at(x, y)`, `.cars()`, `.hit()`, `.onHit(fn)` | Place → Traffic |
| stunts | `api.stunts.ids()`, `.show(id, on)`, `.visible(id)`, `.where(id)` | Place → Stunts |
| placements | `api.placed(id)`, `api.placedWith(tag)`, `api.placements()` | Place → Place |
| models | `api.models.spawn(asset, pose)`, `.move()`, `.show()`, `.remove()` | Assets → Catalog |
| physics | `api.physics.explode()`, `.impulse()`, `.break()`, `.ray()`, `.profile()`, `.car()`, `.onImpact(fn)` | when physics is on |
| weapons | `api.arm(entity, weapon)`, `api.fire(entity, dir)`, `api.hurt(entity, amount)` | Assets → Weapons |
| conditions | `api.time('18:30')`, `api.weather(...)`, `api.preset(id)`, `api.hide(...)`, `api.transport(mode)` | |
| sound | `api.audio.play(slot, { at, gain })`, `.loop(slot)`, `.override(slot, clips)`, `.slots()` | the sound bank |
| score and winnings | `api.score.currency('$')`, `.add(amount, label)`, `.set()`, `.get()`, `.lines()` | |
| the end | `api.win(text)`, `api.lose(text)`, `api.finish({...})`, `api.on('finish', fn)` | |
| the interface | `api.ui.mode('game')`, `api.ui.developer(false)`, `api.ui.teleport(false)`, `api.ui.transport(false)`, `api.ui.settings.hide(...)`, `api.ui.hud.hide(...)` | |
| everything else | `api.world`, `api.actors` | the game's entity system |

The Program pane's completion and hover carry the full declarations, with a description of every
call. An AI agent gets the same declarations from the MCP `program_api` tool.

Besides `@apex/program`, a program can import types and helpers from `@apex/races`,
`@apex/racerun`, `@apex/zones`, `@apex/stunts`, `@apex/trafficsets`, `@apex/vehicles` and
`@apex/actors`.

## Winning, losing and the finish screen

The score is the winnings: one number, shown on the HUD and the finish screen.
`api.score.currency('$')` makes it money; `api.score.add(20, 'Hits')` pays into a labelled line of
the breakdown, and the same label again adds to that line and counts it.

```ts
api.finish({
  outcome: 'win',                 // or 'lose', 'abandoned'
  title: 'Beltway cleared',
  text: 'Five appointments kept.',
  stats: [{ label: 'Legs', value: '5/5' }],
  show: 'car',                    // 'character' or 'none'
})
```

Every field is optional; `api.win(text)` and `api.lose(text)` are shortcuts. The first ending
counts. The finish screen offers **Next stage** (when the level names one for that outcome),
**Restart** and **Exit to menu**. `api.finish({ screen: false })`, or
`defineGame({ finishScreen: false, ... })`, leaves the screen to you.

## Taking things away from the player

Everything is allowed by default, and every restriction ends when the program stops:

```ts
api.ui.mode('game')                         // this run is in game view whatever the player chose
api.ui.developer(false)                     // no developer view from the menu
api.ui.teleport(false)                      // the map's double-click does nothing
api.ui.transport(false)                     // no getting out of the car
api.ui.settings.hide('display', 'controls.reset', 'game.tuning')
api.ui.hud.hide('gear')                     // speed, gear, heading, road, elevation, objectives, waypoint
```

Setting ids are a fixed list; a misspelt one is an error in the editor, not a control that quietly
stays.

## Sounds in a program

```ts
api.audio.play('explosion', { at: { x, y, z }, gain: 0.8 })   // omit `at` to play at the player
const squeal = api.audio.loop('tire.squeal.loop'); squeal.set(0.6); squeal.stop()
api.audio.override('crash.heavy', ['crash-heavy/slam-1'])     // this world's clips for a slot
api.audio.override('crash.heavy', null)                       // back to the bank
```

`api.audio.slots()` lists every slot with what it is for. Loops stop and overrides are undone when
the program stops.

## Scenarios without code

For simple rules, a level's **scenario** (Stage → *Something to do*) may be enough: when a condition
on the run's facts holds, show a message or take an action. Use a program when you need more.
