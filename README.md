# OSE Dungeon Turn Tracker (Foundry VTT v13/v14)

Digital version of the Old-School Essentials Dungeon Time Tracker sheet.

## Installation
1. Unzip so you get `Data/modules/ose-dungeon-turn-tracker/module.json`.
2. Restart Foundry, enable the module in *Manage Modules*.

## Usage
- Open: hourglass button in the Token controls (left toolbar), a keybinding
  (Configure Controls), or a macro: `game.modules.get("ose-dungeon-turn-tracker").api.open()`
- **Next turn** ticks off a box. On W turns a 1d6 wandering check is rolled (whispered
  to GM by default); on R turns a rest reminder is posted unless the party rested that hour.
- **Rest** spends one turn resting (box turns green).
- **Torch / Lantern / Timer** add light or spell timers; they show as letters in the box
  where they expire and post a chat message when they run out. Durations accept dice (1d6+6).
- Click any box to jump to that turn (click the last ticked box to un-tick it).
- Settings: check interval, X-in-6 chance, rest interval, whisper, sync world time, player view.

Macro API: `api.advance(n)`, `api.setTurn(n)`, `api.rest()`, `api.addTimer({label, duration, type})`.
