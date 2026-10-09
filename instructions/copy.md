# copy.md — 한국어 카피 규칙(교정·검토·리듬)

`KOREAN_COPY_POLISH_RULES` 는 교정·검토 단계에만 들어간다(초안 생성 프롬프트에는 넣지 않는다).
리듬 규칙 두 절은 `<copy-rhythm-policy id="legacy_rhythm|natural_v1">` 래퍼(코드) 안에 들어간다. NATURAL 절 끝 줄바꿈은 코드가 붙인다.

## KOREAN_COPY_POLISH_RULES

KOREAN AI-TELL RULES (post-editing only; adapted from the MIT-licensed im-not-ai rulebook). These describe wording that makes Korean copy sound machine-written. Most are ordinary Korean when used once — act on clear cases and pile-ups, never treat them as bans.
A. Translationese: "~에 대해/~에 있어서/~와 관련하여/~에 기반하여" → a direct particle ("성분에 대해 확인" → "성분을 확인"); "~을 가지고 있다" and other have/make/give+noun calques → a plain predicate ("흡수력을 가지고 있어요" → "흡수가 잘 돼요"); double passive "~되어지다/~지게 되다" → active or single passive; "~에 의해" → make the agent the subject; repeated "~를 통해" or "~을 위해" → "~로", "~려고", "~도록".
B. Abstract subject + all-purpose verb ("편안함을 제공합니다/선사합니다/가져다줍니다/보여줍니다") → a concrete subject doing a concrete thing.
C. Significance inflation with no fact behind it ("주목할 만한", "매우 중요한", "혁신적인", "차원이 다른", "완벽한") → delete it, or say the concrete supported fact that is already in the copy. Never invent one.
D. Formulas: "단순한 X를 넘어 Y", "X에서 Y로", cleft "중요한 것은/핵심은/문제는 ~입니다" → a direct statement; "A가 아니라 B" contrast used more than once → keep one; closing formula "~할 때입니다/~할 시간입니다" at most once; personified abstractions ("기술이 답합니다") → a person or the product as subject.
E. Connectives: sentence-initial "또한/따라서/결론적으로/이를 통해/그리고" chains → drop them; no comma right after a connective ending (-고, -며, -지만, -면서).
F. Rhythm: three or more consecutive sentences with the same ending or the same length → vary one; stacked three-item parallels ("빠르고, 쉽고, 간편하게") → keep at most one in the whole copy.
GUARDS: keep proper nouns, numbers, units, dates and quotations exactly. Narration is read aloud by TTS: keep Hangul transcriptions of brands and units as written ("600밀리그램", "종근당" stay); never convert narration into "600mg" or other Latin letters, and never "standardize" spoken units into symbols. Keep a hedge or condition ("~일 수 있어요", "개인차가 있어요") as a hedge — never raise it to a flat claim. Keep the content nouns of each sentence; change particles, endings and filler, not the claim. Do not introduce any of these patterns while fixing another. A line that already sounds like a person talking stays unchanged; over-editing is a failure.

## KOREAN_COPY_RHYTHM_RULES

KOREAN COPY RHYTHM RULES (apply to narration and screen copy; never change facts, numbers, units or claims):
1. ONE SENTENCE = ONE BEAT. Situation, twist and feeling are separate sentences. Target {{COPY_BEAT_TARGET_CHARS}} Korean characters or fewer per sentence (about one breath, 2–4 seconds); never more than {{COPY_BEAT_MAX_CHARS}}. A chain step may take 2–3 short sentences. Cut a question before its twist: "…인 줄 알았죠? / 근데 ….".
2. SHOW THE ACTION, NOT THE INSTRUCTION. Prefer a verb the hand can do ("뒤집어 보세요", "두 줄만 읽어요") over abstract verbs ("확인하세요", "선택할 수 있어요"). Reuse one such action word 2–3 times across the script (pain → outcome → cta) so it becomes the rhythm.
3. NAIL IT WITH REPETITION. Repeat the key number or word ("두 줄", "백 퍼센트", "한 방울도요") instead of paraphrasing it.
4. END SHORT AND SPOKEN. Finish on 예요/죠/세요/요; cut explanatory tails ("~할 수 있어요", "~이라는 뜻은 아니에요", "~되어 있습니다", "~표기되어"). Hedges that weaken the ad go away unless FACTS require the caveat.
EXAMPLE (same facts, before → after):
- "싸서 산 캡슐, 올리브유 백 퍼센트인 줄 알았는데 대두유가 섞여 있어 속은 기분이었나요?" → "싸게 산 올리브 캡슐, 뒤집어 봤더니 대두유. / 백 퍼센트인 줄 알았는데요. / 그 기분, 아시죠?"
- "제대로 고르려면 종류와 비율을 읽고, 다른 식물성 기름이 섞이지 않았는지 봐야 해요." → "볼 건 두 줄이에요. / 무슨 기름인지, 몇 퍼센트인지."
- "종근당 퓨어 엑스트라 버진 올리브 오일 캡슐은 다른 식물성 기름을 섞지 않았어요." → "종근당 퓨어는 다른 기름을 안 섞어요. / 한 방울도요."
- "이제 막연한 기대 대신, 원재료를 읽고 올리브유 백 퍼센트인 제품을 고를 수 있어요." → "이번엔 뒤집어 보고 사세요. / 두 줄이면 끝나요."

## NATURAL_COPY_RHYTHM_RULES

NATURAL KOREAN COPY:
1. One sentence expresses one complete thought. Keep it easy to speak, normally within {{COPY_BEAT_TARGET_CHARS}} characters and always within {{COPY_BEAT_MAX_CHARS}}, but do not split a coherent event solely to reach {{COPY_BEAT_TARGET_CHARS}} characters. Situation, discovery and feeling are not three mandatory beats.
2. Open on ONE concrete event. A short question may work, but do not repeat that event as a second question or add a standalone emotion sentence. Remove redundant opening material instead of dividing it into more lines.
3. Every next sentence adds a reason, a useful fact, a visible change or one next action. Do not repeat a percentage, ingredient or action word just to create rhythm. A purposeful final reminder is allowed when it helps the viewer decide.
4. Prefer ordinary concrete Korean. Describe what the viewer notices or compares; do not turn all copy into instructions to read, check or choose. An ingredient name can be read, but a proportion is compared: name the actual distinction instead of saying abstractly to read ratios or mixing status.
5. Keep product facts, scope and uncertainty unchanged. Remove duplicate phrasing without deleting the only occurrence of an important condition. Keep a qualifier with its claim instead of building a separate caveat scene.
6. Let the image finish the thought. Do not narrate filler while a clear 3D explanation unfolds. Use the supplied product name where it first answers the viewer's question, and connect the ending to one useful next action.
