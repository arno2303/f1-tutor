# Your own voice cues

Without recordings, F1 Tutor speaks the cues ("Brake", "Turn", "Throttle") with your
system's speech voice in the app's language.

To use your own voice instead, put these files here and restart `server.py`:

| File | Cue |
|---|---|
| `Brzda.m4a` | Brake |
| `Zaboc.m4a` | Turn |
| `Plyn.m4a` | Throttle |

Any format your browser can decode works if you keep these names. Silence at the start
is skipped and loudness is evened out when they're played. A cue without its own file
is still spoken. These files are ignored by git, so they stay on your machine.
