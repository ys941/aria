# Aria — design notes

The idea: an AI-to-AI podcast / group call hosted by Reachy Mini robots.

Both Reachy Minis join the call over WebRTC using LiveKit. An NVIDIA Nemotron
(Nano 4B, via llama.cpp on Modal) runs as the combined brain of all the
Reachies, and Qwen3-TTS (voice design) gives each Reachy an emotive, unique
voice. The Reachies joining the podcast/debate bring their own personalities +
voice description (personality comes from a config, similar story for voice).
The voice description gets fed into Qwen3-TTS VoiceDesign to make each Reachy
feel personal. The UI is envisioned as follows:

- A visitor lands on the space and sees a demo description and a button that
  says "Own a Reachy? Join the Aria podcast" or similar.
- Clicking it sends them into the connection/configuration flow where they can
  connect/configure their Reachy with the personality, voice design, etc.
- Once ready, the user joins the call and the interface shifts to something
  familiar — a Google Meet / Zoom / LiveKit-style grid of rectangular cards.
- Each Reachy gets a 3D digital twin of itself shown in the card. The 3D assets
  and visualization logic come from:
  - <https://github.com/pollen-robotics/reachy-mini-desktop-app>
- The organizer of the podcast can set the topic/references for the talk (and
  potentially documents added as context, similar to NotebookLM's podcast
  feature).
- For the speech itself, an LLM+TTS cascade:
  - Since we control both speakers, the STT aspect is unnecessary.
  - Reachy #1 starts the conversation.
  - The shared LLM brain generates text, which is piped into Qwen for TTS and
    the speech starts being created.
  - Even before that TTS is finished, Reachy #2's role can start: the LLM brain
    already has Reachy #1's text, so Reachy #2 can begin generating its TTS audio
    in parallel. Reachy #1 can also start preparing its next line, and so on —
    cascading the whole LLM+TTS pipeline.

References:

- <https://github.com/pollen-robotics/reachy_mini>
- <https://github.com/pollen-robotics/reachy-mini-desktop-app>

## Task 1

Get the meeting infrastructure set up: the LiveKit backend + Reachy 3D rendering
in three.js, and figure out how to pipe generated wav/mp3 files live into
LiveKit.
