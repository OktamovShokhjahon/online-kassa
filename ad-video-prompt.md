# Online Kass — 30-second ad video in Uzbek (AI video prompts)

A complete prompt package for a 30-second Uzbek ad with sound. It is built for AI video tools that generate
picture and audio together: **Google Veo 3.1** fits best, **Sora 2** or **Kling** also work. These tools make
clips of about 8 seconds, so the ad has **4 scenes**. Generate each scene separately and join them in an editor
(CapCut, Premiere).

**Before you start**

- **Website screens:** AI tools draw made-up screens and broken text. For shots where a screen is visible,
  film the real website (or screen-record it) and place it on the monitor in the editor. The prompts below keep
  screens blurred or angled for this reason.
- **Uzbek text:** add all on-screen text (titles, logo, slogan) in the editor, not in the AI prompt — the models
  get Uzbek letters wrong.
- **Fill in yourself:** the website address / phone number for the final frame.

---

## 1. Shared style (paste at the start of every scene)

```
STYLE: Premium TV commercial, cinematic, shot on ARRI Alexa, 35mm lens, shallow depth of field,
soft warm natural light, gentle slow camera moves (dolly, slow push-in). Color grade: deep teal
(#074250) and fresh teal (#0B7280) tones with warm saffron-gold (#E29826) accents; clean, modern,
optimistic. Setting: a modern neighbourhood mini-market in Tashkent, Uzbekistan — tidy shelves with
local and imported groceries, bread (non) on a wooden tray, a small Uzbek ceramic plate with blue
patterns on the wall. Realistic Central Asian people, natural skin, no exaggeration.
All spoken dialogue is in UZBEK language (Latin script pronunciation, Tashkent accent), natural and warm.
No subtitles, no on-screen text, no logos, no watermarks. Any computer screen is slightly out of focus
or angled away from camera.
```

## 2. Characters (keep them the same in every scene)

```
CHARACTERS:
- AZIZ, the shop owner: Uzbek man, about 40, short black hair, neat short beard, kind tired eyes,
  navy blue polo shirt, silver wristwatch.
- MADINA, the cashier: Uzbek woman, about 25, dark hair in a low bun, small gold earrings,
  teal (#0B7280) work apron over a white shirt, friendly confident smile.
- Customers: an elderly Uzbek woman in a light headscarf; a young man in a hoodie.
```

---

## 3. Scenes

Each scene prompt = **Shared style** + **Characters** + the scene text below.

### Scene 1 — The problem (0–8 s)

```
[STYLE + CHARACTERS]

SCENE: Evening inside the mini-market. Light is a little dim and cold. A long queue of customers waits
at the counter. MADINA, stressed, writes prices into a worn paper notebook and taps a cheap calculator;
coins spill. AZIZ stands behind her, rubbing his forehead, looking at a messy stack of papers.
Camera: slow push-in from the queue to Aziz's worried face.

AUDIO:
- AZIZ (voice-over, calm, tired, Uzbek): "Navbat uzun, daftar toʻla, kechqurun esa hisob toʻgʻri chiqmaydi..."
- SFX: murmuring queue, calculator beeps, coins dropping on the counter, a customer sighing.
- MUSIC: a quiet, slightly tense low synth pad, single slow doira (frame drum) heartbeat rhythm.
```

### Scene 2 — The solution: a quick sale (8–16 s)

```
[STYLE + CHARACTERS]

SCENE: Same shop, next morning, bright warm sunlight, everything feels fresh and calm. The notebook is
gone. MADINA scans a bottle with a handheld 2D barcode scanner — a soft beep — then looks at a slim
monitor (screen angled, softly glowing teal). A compact thermal receipt printer instantly prints a
receipt; she tears it off with a smile and hands it to the elderly customer with her bag.
Camera: close-up of the scanner beam on the barcode, quick cut to the receipt sliding out of the
printer (macro), then medium shot of the smiling exchange.

AUDIO:
- NARRATOR (female, young, confident, warm, Uzbek): "Online Kass bilan hammasi oson: skanerlang — chek bir zumda tayyor."
- MADINA (to the customer, smiling): "Xaridingiz uchun rahmat!"
- ELDERLY CUSTOMER (warmly): "Rahmat, qizim!"
- SFX: crisp scanner beep, fast thermal printer whirr, paper tear, cash drawer softly opening.
- MUSIC: energy rises — upbeat modern pop beat with doira rhythm and a bright dutar (two-string lute) riff.
```

### Scene 3 — Control from anywhere, even offline (16–24 s)

```
[STYLE + CHARACTERS]

SCENE: AZIZ sits in a cozy Tashkent café with a cup of green tea in a traditional piyola. His phone
buzzes on the table; he picks it up and smiles (phone screen glowing teal, not readable).
Quick cut: back in the shop, the Wi-Fi router's lights blink off, but MADINA keeps scanning and the
printer keeps printing without stopping; she does not even notice. Then the router lights come back on.
Camera: smooth handheld in the café, then a static close-up on the router, then a match cut to the printer.

AUDIO:
- NARRATOR (Uzbek): "Savdo, qoldiq va foyda — doim telefoningizda. Internet uzilsa ham, kassa toʻxtamaydi."
- SFX: phone notification "ding" (Telegram style), café ambience, router click, steady scanner beeps.
- MUSIC: full groove — doira + dutar + light electronic bass, confident and positive.
```

### Scene 4 — Final scene and logo (24–32 s)

```
[STYLE + CHARACTERS]

SCENE: Golden-hour light in the shop. AZIZ walks in, stands next to MADINA behind the counter; they
exchange a relaxed, proud smile while the last customer leaves happily. Camera slowly pulls back
through the shop window to the street; the image gently transitions into a clean deep-teal (#074250)
background with a slowly rotating saffron-gold eight-pointed star made of two overlapping squares
(inspired by Registan tilework), glowing softly. Leave empty space in the centre for a logo.

AUDIO:
- NARRATOR (Uzbek, warm and memorable): "Online Kass — doʻkoningiz doim nazoratda. Bugunoq sinab koʻring!"
- SFX: door bell chime as the customer leaves, soft whoosh into the logo, a gentle shimmer on the star.
- MUSIC: final uplifting dutar phrase and a strong doira hit at the end, then a short reverb tail.
```

---

## 4. Negative prompt (if your tool has one)

```
no subtitles, no captions, no on-screen text, no gibberish letters, no fake logos, no watermarks,
no distorted hands or fingers, no extra fingers, no warped faces, no cartoon style, no oversaturated
colours, no dark horror lighting, no Russian or English speech, no robotic voice, no lip-sync errors
```

---

## 5. Text to add in the editor (Uzbek)

| Time | Text |
|---|---|
| 1–6 s | **Daftar, kalkulyator, chalkash hisob?** |
| 9–15 s | **Skanerlang → chek tayyor** |
| 17–20 s | **Savdo va qoldiq — telefoningizda** |
| 20–23 s | **Internetsiz ham ishlaydi** |
| 26–32 s | Logo **Online Kass** + **Doʻkoningiz doim nazoratda** + website / phone number |

- **Fonts:** the website uses **Unbounded** (headings) and **Onest** (text), so the ad matches it.
- **Colours:** deep teal `#074250`, teal `#0B7280`, saffron `#E29826`.

---

## 6. Separate voice and music (if the video tool's voice is weak)

### Voice-over script

For ElevenLabs or another text-to-speech tool; pick a natural Uzbek voice (male for line 1, female for the rest).

```
[0–8 s, male, tired]        Navbat uzun, daftar toʻla, kechqurun esa hisob toʻgʻri chiqmaydi...
[8–16 s, female, confident] Online Kass bilan hammasi oson: skanerlang — chek bir zumda tayyor.
[16–24 s]                   Savdo, qoldiq va foyda — doim telefoningizda. Internet uzilsa ham, kassa toʻxtamaydi.
[24–32 s, warm, slower]     Online Kass — doʻkoningiz doim nazoratda. Bugunoq sinab koʻring!
```

### Music prompt

For Suno, Udio or ElevenLabs Music.

```
30-second upbeat commercial jingle, modern Uzbek pop fusion, 110 BPM, starts quiet and tense
(soft synth pad + slow doira heartbeat) for 8 seconds, then bright and optimistic with doira
frame drum groove, dutar melody, warm electronic bass and light claps, ends with a strong
final doira hit and short reverb tail. Instrumental only, no vocals, leave room for voice-over.
```

In the editor, set the music about 10–12 dB below the voice.

---

## 7. Extra versions

- **Instagram Reels / TikTok (9:16):** add `vertical 9:16 format, subjects centred, close framing` to the
  shared style. Starting from scene 2 gives a 15-second version.
- **Russian version:** only the voice lines change; the scenes stay the same.
