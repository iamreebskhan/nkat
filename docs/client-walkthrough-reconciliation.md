# Client walkthrough — transcript reconciliation

The supplied Roman-Urdu transcript had errors, so every requirement was
re-verified against two independent signals from the source video:

1. **A second ASR decode.** `whisper-large-v3-turbo` (ONNX, q8 encoder / q4
   decoder) run locally against audio extracted from `Pallio.mp4`, 146
   segments, `language=ur`. Independent of the supplied transcript.
2. **Speech-boundary detection.** `ffmpeg silencedetect -32dB:0.45` →
   98 speech segments with exact start/end times, so a line can be checked
   for whether anyone was talking at all.
3. **194 video frames**, one every 2s, to see what was on screen when spoken.

Where the two decodes agree, the requirement is solid. Where they diverge, the
frame decides. Where all three are ambiguous, it is listed as open.

---

## Requirements CONFIRMED by both decodes

| Time | Requirement | Second decode |
|---|---|---|
| 01:27–01:31 | Insurance: the organization, and its state | "insurance organization کی ہو / اس کی بھی state ہو" |
| 02:30–02:32 | Add our own visit types | "اگر کوئی visit types ہو کر رہا ہے جو ہم نے add کرنی ہے" |
| 02:36–02:44 | Different services against visit types | "اگر کوئی visit types کے بھی against … different types of services ہوں گی … کیا کیا ان کو help provide کرنی ہے" |
| 03:16–03:22 | Sign+Submit → all details land in Billing | "sign plus summit for billing جب ہم لوگ کرے تو اس کا جو ہے وہ ساری details ہمارے پاس billing والے میں آ رہی ہوں" |
| 03:23–03:32 | Billing dashboard: per client, per nurse, bill counts, statuses | "یہاں پہ پورا ڈیش بور بنے گا بلنگ کا … کس پلائنٹ کے کیا چیزیں چل رہی ہیں … کس نرس نے … کون کتنے بلز" |
| 03:38 | "Create Bill" button | "یا کریٹ بل کا بٹن ڈال کے" |
| 03:52–04:02 | Client selection, then which appointment | "client selection add ہوگا … کونسی appointment کے against" |
| 04:37–04:43 | Rulebook: don't remove, only update the UI | "اچھا یہاں رموو نہیں کرنیا … اس کی بس اپ ڈیٹ کرنیا … بس UI اپ ڈیٹ کرنی ہے" |
| 04:53–05:00 | Reports duplicates Dashboard, remove for now | "یہ رپورٹس اور یہ ڈیش پر سیم ہے … تو اس کو رموو … اگر فیلال کے لیے" |
| 05:43 | Check the whole thing flow-wise | "لیکن جو فلو وائز ہے وہ چیک کر لو" |
| 05:48–06:03 | Bill editing on rejection, by the nurse | "درشبور کے ساتھ کہ وہ ایڈیٹ وغیرہ ہم کر سکیں … اگر ریجیکشن آتی ہے ایجنٹ کے سائٹ سے … نرس جو ہے وہ یہاں پر آکے اپ ڈیٹ وغیرہ کر سکے اس بیل کو" |
| 06:09–06:18 | Activity history is mandatory, 3 entries | "اس کی ہسٹری ہمیں لکھنی پڑے گی … ایکٹیویٹی ہسٹری لازمی لکھنا … یہ پہلے بل تھا یہ ریجیکٹ ہو آیا اور اب یہ نیو بل ہے" |

---

## Corrections to the supplied transcript

**[01:29] "us ki [links]" does not exist.** The supplied transcript guessed
`[links]`. The second decode reads "اس کی بھی state ہو" — *its state too*, a
repeat of the previous clause. There was never a "links" requirement. This was
the one open item that had no implementation; it needs none.

**[01:38]–[01:49] wording differs, meaning doesn't.** Supplied: "primary
diagnosis and preliminary referral context… Referring physician". Second
decode: "primary diagnosis and peripheral context… reflecting physician". The
words diverge; both decodes agree the very next utterances are "یہ صحیح ہے"
and "I think so" — *this is fine*. Review passed, no work implied. Frame `105s`
confirms those fields were already on screen.

**[00:34]–[00:44] is unreliable in both decodes.** The supplied text and the
second decode are both partly nonsense here ("jo AI ne hataye" vs "جو آئی
آٹانے مجھے"). Neither can be trusted. **The frame settles it**: `087s` shows the
Insurance step with *Primary payer ID (optional)*, *Member ID (optional)*,
*Group number (optional)*, *Coverage effective (optional)* — every field marked
optional, which is exactly the complaint. Built from the frame, not the text.

**[01:24]–[01:27] contains a decode loop.** The second decode emits "آئیکا"
~80 times — a Whisper repetition artifact. Unusable. The supplied transcript's
reading (an info icon revealing details) is corroborated by the frames and by
the clean segment at 02:03–02:06 about hover.

---

## The 04:16–04:28 fee line

Flagged as "never mentioned". Both decodes independently produce it:

- supplied: "ke us ki fee yeh hai, kyunke humare paas client ki information mein hoga"
- second decode, 266.88→269.68: "کیونکہ ہمارے پاس کلائنٹ کی انفرمیشن میں ہوگا وہ"

`silencedetect` confirms real speech at 267.03–269.42 (2.4s), matching that
segment boundary. So the phrase is in the audio — **but the surrounding span
256.8–266.88 contains an obvious decode loop** ("یہاں" ×9), so the region is
degraded and the sense is not safe to build on.

**It changed nothing in the code.** Frames `250s`/`262s`/`270s` show the client
was looking at **Rule lookup** — no fee field, no client rate, anywhere on
screen. He was specifying the Create Bill flow, not reading one. So the fee was
implemented from the visit's coded charges (which is also the billing-correct
source; a fee derives from CPT codes, not from the client record). No
client-level rate was added.

If the intended meaning was "you'll find the visit under the client's
information", that is what was built.

---

## Method notes

- Audio: `pallio-16k-mono.wav` (16 kHz mono) extracted with ffmpeg.
- The second decode is quantised and runs on 4 CPU cores; it is **less**
  accurate than the supplied `large-v3-turbo fp32 + beam search` run. Its value
  is as an independent opinion, not as a replacement.
- Repetition loops ("یہاں یہاں یہاں…") are a known Whisper failure mode and mark
  spans where neither decode should be trusted.
- Roman-Urdu ASR renders unfamiliar domain phrases as plausible-sounding
  near-words rather than dropping them, which is why silent corruption is the
  failure mode here rather than obvious gaps.
