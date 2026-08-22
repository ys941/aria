<div align="center">

# 🤝 Contributing to Aria

**Two robots argue about pineapple on pizza. Neither of them knew what they'd say.**<br>
If that makes you want to poke at the code, you're in the right place.

<sub>Bug reports · features · docs · a better voice · a nicer theme — all of it counts</sub>

</div>

---

## 👋 Start here

Aria was built by one person, learning as they went, mostly after midnight on a
two-core laptop with no GPU. Two things follow from that:

1. **There are rough edges.** You'll find things that make you think *"why on earth
   is it done like this?"* Sometimes there's a reason. Often it just never got cleaned
   up. Ask — or fix it.
2. **Your first pull request is welcome here.** Genuinely. If you've never contributed
   to open source, this is a reasonable place to start, and questions aren't an
   imposition.

No contribution is too small. Fixing one confusing sentence in the README counts.

---

## 🚀 Getting it running

You need **Python 3.11+**. That's the only hard requirement to see the UI.

```bash
git clone https://github.com/ys941/aria.git
cd aria
pip install -r requirements.txt

cp .env.example .env
python app.py          # http://localhost:7860
```

**One variable is required:**

| Variable | What it's for |
|---|---|
| `ATTRIBUTION_ACK` | Set to `https://github.com/ys941` — the app won't start without it ([why](#-attribution)) |

Everything else in `.env.example` only unlocks the feature it powers:

| Group | Without it |
|---|---|
| `LIVEKIT_*` | No live audio streaming — the UI still loads and the robots still render |
| `MODAL_LLM_*` | No script generation — you can't start a new episode |
| `MODAL_TTS_*` | No voices — scripts appear as subtitles, silently |

You do **not** need any paid account to work on the frontend, the themes, the 3D scene,
or the docs.

> 💡 The LiveKit values in `.env.example` are the standard local dev defaults
> (`devkey` / `secret`) and work with `livekit-server --dev`.

---

## 🧭 Where things live

```
app.py                  entry point — a gradio.Server hosting our own UI + /api
backend/
├─ server.py            the /api control plane
├─ showgen.py           writes the episode: cast, personalities, ~24 lines
├─ audio.py             turns lines into speech
├─ publisher.py         streams the audio into the LiveKit room
├─ tokens.py            mints LiveKit access tokens
└─ attribution.py       the attribution gate
frontend/
├─ index.html           the whole meeting UI
└─ dist/                built assets
radio/                  the built-in station
```

Start with `backend/showgen.py` if you want to understand how an episode is born, or
`frontend/index.html` if you want to change what it looks like.

---

## 💡 Things worth doing

Nobody's working on these. No permission needed — just say so in a PR or discussion so
two people don't do the same work twice.

| | Area | Why it matters |
|:--:|---|---|
| 🧪 | **Tests** | There is no test suite. Biggest gap, and the easiest start — the script parsing and theme logic are pure functions needing no accounts. |
| ♿ | **Accessibility** | Subtitles exist, but the UI has never been checked with a keyboard or screen reader. |
| 🎨 | **Themes** | Fifteen exist and they're data-driven. New ones are mostly taste. |
| 🗣️ | **Voices** | More voices, better pacing, less robotic delivery between lines. |
| 🎓 | **Practice mode** | The coach/learner/guide format could cover more scenarios and levels. |
| 📖 | **Docs** | A setup guide written by someone who just did the setup — including where they got stuck — beats one written by the author. |
| ⚡ | **Performance** | The 3D scene has never been profiled on low-end hardware. |

---

## 🔀 Sending a pull request

```bash
git checkout -b fix/robots-talking-over-each-other
# ... make the change ...
python app.py           # it should still start
git commit -m "fix: wait for the previous line to finish before speaking"
git push origin fix/robots-talking-over-each-other
```

What helps:

- **Say what changed and why.** One honest paragraph beats a formal template.
- **Keep it focused.** One idea per PR.
- **A clip for anything visual or audible.** Before and after, if you can.
- **Say if you're unsure.** "I couldn't test the LiveKit path" is useful information.

Reviews may take a few days — this is nobody's day job. A nudge after a week is fine.

---

## ⭐ Attribution

Aria is free to use, fork, self-host, rebrand and build a business on. There is one
condition, and it is deliberately small:

**Credit to the original author stays visible.**

- The UI footer reads *"Made with ❤ by Yati Bhardwaj"* and links to
  [@ys941](https://github.com/ys941). Everything around it is yours to change.
- The server runs two checks at start-up: `ATTRIBUTION_ACK="https://github.com/ys941"`
  must be set in your environment, **and** the footer must still contain the credit.
  Strip the credit and the app refuses to boot. Nothing is transmitted — both checks
  are local.

This is **clause 2 of the [licence](LICENSE)**, so it applies whether or not the check
is present — deleting [`backend/attribution.py`](backend/attribution.py) does not remove
the obligation. A purely private deployment nobody else uses is exempt.

Full detail on what you may and may not do: [COPYRIGHT.md](COPYRIGHT.md).

---

## 🎨 Code style

No linter gate, no formatting police. Match the surrounding code. Python is typed where
it helps and not where it doesn't.

One rule that matters more than style:

> ### ⚠️ The show must go on
>
> Every stage degrades gracefully. No voices available → subtitles still appear. A
> provider rate-limited → the next one picks it up mid-episode. If your change can make
> the app show an error instead of a podcast, it isn't finished.

---

## 🐛 Reporting bugs

Open an issue with whatever you have. Rough is fine — what you expected, what happened,
and anything from the console.

> ⚠️ **Scrub your API keys and endpoint URLs** out of anything you paste.

## 🔐 Security issues

Please **don't** open a public issue. Email **ys9410017064@gmail.com** and give it a few
days before disclosing publicly. You'll be credited unless you'd rather not be.

---

## 📜 Licence

Contributions are made under the [MIT Licence with Attribution Requirement](LICENSE),
the same as the project.

See [COPYRIGHT.md](COPYRIGHT.md) for exactly what you may and may not do with this code —
the short version is "almost anything, just keep the credit".

---

<div align="center">

**Thank you for being here.** ⭐

<sub>Not sure where to start? Open a discussion and say what you'd like to work on —<br>
you'll get an answer, and probably a pointer to the right file.</sub>

</div>
