# flow.md — Veo 클립·Flow 설명 컷·이미지 프롬프트의 고정 문장

서버가 생성 호출마다 읽는다(재시작 불필요). `## KEY` 머리글은 바꾸지 말고, `{{TOKEN}}` 은 남겨 둔다
(대문자 토큰은 thresholds.json 값, 소문자 토큰은 코드가 호출 시점에 채운다). 어느 절이 어디에 쓰이는지는 README.md 표를 본다.
문장 사이를 잇는 공백·줄바꿈·번호(1) 2) …)는 코드가 붙이므로 절에는 문장 본문만 적는다.

**최신 결정(2026-10-09): Veo 3.1 Lite + HyperFrames.** 맨 아래 VEO_HF_INFO_IMAGE·VEO_HF_MOTION·HF_LABEL_LAYER_RULES는 승인된 제작 지침이며 새 카피 먼저 대본의 labelLayer 경로에 연결됐다. Veo는 물체·움직임과 물체 자체의 설명 효과를 만들고, HyperFrames는 글자·라벨판·연결선/화살표·끝점·라벨용 대상 강조를 한 세트로 합성한다. Omni 전환 문구 초안은 보류했다.

labelLayer가 있는 새 카피 먼저 대본은 infoLines를 합성용으로 보존하며 글자 없는 INFO·Veo 프롬프트와 별도 이미지 검사를 쓴다. labelLayer가 없는 기존 대본은 기존 프롬프트·글자 대조·다이제스트를 유지한다. HyperFrames 자동 합성이 연결됐다. 이미지 검사를 통과한 글자 없는 원본을 업로드하면 03 라벨 세트를 합성한다. 계획 좌표의 실제 대상 정합과 모바일 결과는 최종 영상에서 확인한다. 세부 절차는 FLOW-MODE.md 13절과 FLOW-AGENT-BRIEF-VEO-HYPERFRAMES.md를 따른다.

호출 토큰 설계: scene은 승인된 설명 관계·물체·설명 세계, actions는 물체 동작과 최종 상태, veoGraphics는 라벨과 독립적인 물체 설명 효과만, camera는 시작 위치·대상·이동 경로·최종 구도다. infoLines의 정확한 문구와 라벨용 그래픽은 HyperFrames 계획에 보존하며 Veo 이미지·영상 프롬프트에 넣지 않는다. 카피와 대본 원문은 수정하지 않는다.

## CLEAN_KEYFRAME_TAIL

No text, letters, arrows, numbers, labels, icons or highlight rings anywhere in the image; leave clear negative space for graphics added later.

## CLIP_PLAN_TAIL

Start exactly from the supplied image. One continuous camera move through the same 3D space: no cuts, no scene changes, no jump to another angle. At the end of each phase settle on a stable composition and hold it for about 0.4 seconds. Keep the same person, product and background; never create new people or objects. Eight seconds, 9:16. No text, letters, logos or lip sync at any moment.

## CLIP_LEGACY_TAIL

Start exactly from the supplied image. Keep the same product, person and setting. Eight seconds, 9:16, no on-screen text, no lip sync, no extra logos.

## HYBRID_LIVE_TAIL

Photographic live action: a real person in a real setting with the real product, natural light and skin; not a clay model, illustration or 3D explainer world. The person's face stays inside the frame; any phone, tablet or monitor screen is switched off (dark glass, no readable content).

## EXPLAINER_WORLD

Clay-white 3D model world under soft daylight on a warm ivory floor and backdrop, exposure one stop below pure white (no blown-out white void): tangible objects with matte material shading, soft contact shadows and real depth. No people, hands, faces or characters anywhere.

## EXPLAINER_TEXT_RULE

No text, letters, numbers, labels, name tags, leader lines, arrows, rings, icons, speech bubbles, value boxes, tables, checklists, logos or flat UI panels anywhere in this text-free image or clip, in any language. Spoken captions are added separately by the app.

## EXPLAINER_COLOR_ACCENT1

the first brand accent color

## EXPLAINER_COLOR_ACCENT2

the second brand accent color

## EXPLAINER_COLOR_NEUTRAL

neutral clay-white

## EMPHASIS_COLOR_CODE

{{name}} takes on {{color}} so it reads apart from the other objects by color alone; the other objects keep their colors.

## EMPHASIS_OUTLINE

a bold, clearly visible outline traces the silhouette or relevant boundary of {{name}} without hiding its structure; use the planned graphic color with strong contrast against the object and background, not a mandatory thin red line.

## EMPHASIS_GLOW_LINE

a clearly visible glowing line or arrow follows the surface or travel path of {{name}}, using the planned high-contrast graphic color and thickness rather than mandatory white; it explains the actual route inside the scene, never a free-floating spiral, squiggle or letter-like shape.

## EMPHASIS_GHOST_OBJECT

a translucent ghost object appears beside {{name}} as a physical analogy of its size, amount or role, see-through and placed with correct depth.

## HYBRID_CLEAN_OBJECTS

Objects in the scene (identifiers are production references, never visible text): {{objects}}

## HYBRID_CLEAN_START_STATE

Show the objects in their starting state, before any action happens; leave clear negative space around them and keep the lower part of the frame uncluttered for the app's caption line. In a comparison the models start identical in shape, size and neutral clay-white, their difference hidden inside.

## HYBRID_ANCHOR_LINE

Explainer world and its two brand accent colors (the first and second accent named here): {{explainerAnchor}}

## HYBRID_OVERLAY_BASE

Use the attached CLEAN image as the same 3D scene: preserve object identity, materials, camera framing and light. Apply only the planned object-state changes below; do not crop, add unrelated objects or restyle the scene.

## HYBRID_OVERLAY_ACTIONS

Show the final state reached after these actions, in order; the described INFO state and the last action must agree: {{actions}}

## HYBRID_OVERLAY_EMPHASIS

Add only these emphasis marks, each attached to an object in the scene: {{emphasis}}

## HYBRID_OVERLAY_NO_EMPHASIS

No emphasis marks: the only difference from CLEAN is the finished actions.

## HYBRID_OVERLAY_NO_FLAT

Emphasis is never a flat graphic: no floating panels, callout boxes, charts, checklists or highlight rings in the air. Keep the original composition and camera of CLEAN.

## HYBRID_OVERLAY_INFOGRAPHIC

Add only the infographic elements needed to explain the relation in the finished scene: a bold arrow for direction, a dimension line with end ticks for a supported measurement, or a boundary/ring for the relevant whole. Attach each to its exact target with correct perspective and depth; omit elements that do not help understanding. Each planned label sits beside its target, on a small flat plate or directly on the surface, large and legible on a phone (each glyph at least 3% of the frame height), in a heavy sans-serif. Use the two base brand colors and additional contrasting graphic colors when needed; preserve object colors and keep the same meaning in the same color across scenes. Give the key label or number the strongest emphasis, not every element equally. Choose line color and thickness for the background rather than defaulting to thin red outlines or white glow. Keep every graphic and text line fully inside the middle band, between {{INFO_GRAPHIC_BAND_TOP}}% and {{INFO_GRAPHIC_BAND_BOTTOM}}% of frame height, without covering key structures or other labels; leave the caption area clear. No floating UI panels, charts, tables or checklists.

## HYBRID_OVERLAY_LABELS

Text rule for this image (it overrides any earlier no-text wording): write exactly these text lines, each exactly once, in Korean exactly as given with the same digits and symbols, and no other letters, words or numbers anywhere: {{infoLines}}

## HYBRID_MOTION_OPENING

Start exactly on the first attached CLEAN frame and end exactly on the second attached INFO frame. One continuous shot inside the same clay-white 3D scene. The phase headings are the single timetable; do not introduce another clock inside camera or action descriptions.

## HYBRID_MOTION_ACTIONS

The objects perform these actions in order, aligned with the phase plan; each reaches its stated result before the next begins and the final object state matches INFO: {{actions}}

## HYBRID_MOTION_EMPHASIS

Emphasis appears in this order and then stays: {{emphasis}}

## HYBRID_MOTION_NO_EMPHASIS

No emphasis marks appear.

## HYBRID_MOTION_CAMERA

Follow the planned start position, target, spatial route and final viewpoint through real 3D depth. Use two or three connected viewpoints across this eight-second source clip, with foreground/background parallax; no cuts or jump to another scene. Movement must reveal the structure, difference, flow or scope being explained, not orbit just to keep moving. Use fast approaches or retreats selectively; settle or slow down when the target, complete label and its boundary need to be read. Keep each phase useful for the planned edit with its required context. No plain cross-fade, static image zoom or slideshow. Preserve object identities and finish in exactly the supplied INFO composition after the planned actions, without unplanned morphing, melting or dissolving.

## HYBRID_MOTION_TEXT

No text at any moment, not even in the last frame: {{@EXPLAINER_TEXT_RULE}}

## HYBRID_MOTION_LABELS

Reveal only the graphics present in the supplied INFO image, at the relevant actions in the shared phase plan: first emphasize the target, then any needed direction, path or boundary, then the complete label or value. Omit unnecessary stages; do not pop every graphic in together at a fixed second. Lines and paths may draw or progress; Korean labels and numbers appear as complete unchanged units, never letter by letter or by morphing. Each line endpoint and label keeps the same target during movement. Keep all wording fully in frame and readable without obscuring the structure, and finish at the exact positions and shapes in INFO. The only text is these lines, in Korean exactly as given: {{infoLines}}. No other letters, words or numbers appear.

## HYBRID_MOTION_LENGTH

Eight seconds, 9:16. No speech, dialogue or lip sync.

## VERTICAL_FRAME

Vertical 9:16.

## IMMERSIVE_PALETTE

Visual system: warm ivory background, dark olive structural forms, and one restrained warm-gold accent. Preserve realistic material shading and depth; no cyan, pink, neon glow, rainbow accents or black presentation-slide backgrounds.

## IMMERSIVE_TEXT_RULE

No text, letters, words, numbers, labels, logos, captions or typographic marks in any language. The app adds all wording later.

## IMMERSIVE_BAND

Keep the explanatory objects and their transformation within the middle {{INFO_GRAPHIC_BAND_TOP}}–{{INFO_GRAPHIC_BAND_BOTTOM}}% of frame height, leaving clear space above and below for app-composited text. Vertical 9:16.

## IMMERSIVE_INFO_LABELS

Render exactly these completed labels, spelled as supplied: {{labels}}. Put each label beside its named target with the planned leader line, arrow or measurement mark. Preserve correct depth and readable contrast without hiding the product. No other words, subtitles, invented quantities, logos or headings. This is the finished infographic image, not a placeholder for later labels.

## IMMERSIVE_CLEAN_DIMENSIONAL

Create the first frame of a dimensional product explainer: tangible three-dimensional objects with material texture, soft contact shadows and visible depth. Use the supplied product reference for actual identity, ingredients, proportions and packaging, not as a demand to include a person or phone in every scene.

## IMMERSIVE_CLEAN_ESTABLISH

Establish the objects that will separate, reveal, compare or move in the planned explanation. A blank phone, empty panel or generic lifestyle photo does not demonstrate an ingredient or a mechanism. Do not invent biological effects, internal anatomy or unsupported performance.

## IMMERSIVE_CLEAN_FORM

Keep the known product form recognizable. If it is a capsule, preserve capsule proportions and a coherent outer shell around its contents; no giant loose oil orb, machine chamber or invented container. A comparison establishes like-for-like scale and viewpoint, not a misleading count of containers.

## IMMERSIVE_OVERLAY_BASE

Use the attached CLEAN frame as the same 3D scene. Preserve object identity, materials, scale relationships and light direction. Create the planned final spatial state, including the final camera perspective; the composition may evolve through the same scene.

## IMMERSIVE_OVERLAY_CAMERA

Final camera perspective: {{camera}}

## IMMERSIVE_OVERLAY_STATE_INTRO

Show these explanatory objects and transformations in their final state:

## IMMERSIVE_OVERLAY_RELATION

Make the relationship physically visible through a justified cutaway, exploded separation, side-by-side material comparison or guided flow, according to the supplied plan. Objects occupy real depth and occlude one another correctly. Do not substitute floating checkmarks, highlight rings or empty UI cards for the explanation. Do not invent ingredients, ratios or physiology.

## IMMERSIVE_OVERLAY_IDENTITY

Every part retains the same identity and appearance as in CLEAN. Show the final understood relation without inventing extra objects. A cutaway preserves the product silhouette and locates its actual contents; a composition diagram must not suggest unsupported physical separation of a mixture.

## IMMERSIVE_MOTION_OPENING

Start exactly on the first CLEAN frame and finish on the last INFO frame. Animate a continuous dimensional explanation in the same physical scene, not a still image with decorative overlays.

## IMMERSIVE_MOTION_STAGES

Animate these stages in order: {{stages}}

## IMMERSIVE_MOTION_OBJECTS

The planned objects visibly separate, reveal their structure, travel along a path or settle into a comparison. Move the camera only when tracking, orbiting or approaching reveals the relationship with parallax; otherwise hold a readable viewpoint. Coordinate any camera motion with each transformation; keep the main action understandable and settle on each result before moving on. No cuts, static zoom, slideshow or cross-fade-only transition.

## IMMERSIVE_MOTION_PRESERVE

Preserve the product, material identities and lighting. Only the objects and transformations described in the plan may appear; no invented ingredients, medical anatomy or physiological outcomes.

## IMMERSIVE_MOTION_BEATS

Follow the explanation beats in chronological progress order. Each change ends in its stated after state and remains visible long enough to understand. Keep the same target identifiable while the camera moves; no extra rolling orb, ejecting contents, decorative mechanical opening or unplanned jump between identities.

## IMMERSIVE_MOTION_LABELS

Preserve the final INFO image's exact infographic labels: {{labels}}. Reveal each completed label and its leader/arrow at the relevant beat; never generate letters one by one. Keep the same line endpoint on the same named target during movement. Never detach a label onto the wrong component, distort its spelling or invent additional text. If motion compromises readability, hold the labeled target while the explanation settles. End exactly on the supplied complete INFO image. No spoken subtitles in the footage.

## IMMERSIVE_MOTION_LENGTH

Eight seconds. No speech, dialogue or lip sync.

## EXPLANATION_CONTRACT_INTRO

Use this structured explanation contract as the identity and action source of truth. Entity IDs are production references, never visible text. Preserve recognizable product form, before/action/after relations and target identities. Beat progress is planned position in the eight-second shot, not measured tracking. CLEAN establishes the objects without graphics; INFO includes the finished explanatory graphics and exact annotation labels. Motion connects those two states with the same target identities. Do not add subtitles to the image: the app adds spoken captions separately.

## INFO_CLEAN_REFERENCE

Use the attached reference photo for the same person, clothes, setting and product; do not invent other products or packaging.

## INFO_CLEAN_FORMAT

Photographic vertical 9:16 image, no logos.

## INFO_OVERLAY_BASE

Use the attached image as the base. Keep the photo, framing, camera angle, lighting, person and product exactly the same; do not crop, move or restyle anything.

## INFO_OVERLAY_ORDER_INTRO

Add these graphic elements, in this order; all of them must be present in the final image:

## INFO_OVERLAY_NO_TEXT

ABSOLUTELY NO TEXT: no letters, words, numbers, digits, labels, captions, logos or typographic marks of any kind, in any language. The app draws all text and numbers later.

## INFO_OVERLAY_STYLE

Graphic style: big, bold and instantly readable; glowing edges, bright outlines and translucent fills; placed in 3D with correct perspective, in front of, behind or on the surface of the subject; callout lines point precisely at their target and never cover a face or the product.

## INFO_OVERLAY_BAND

Place every graphic inside the middle band of the frame, between {{INFO_GRAPHIC_BAND_TOP}}% and {{INFO_GRAPHIC_BAND_BOTTOM}}% of the height from the top. Keep the top {{INFO_GRAPHIC_BAND_TOP}}% and the bottom {{INFO_GRAPHIC_BAND_BOTTOM_FREE}}% free: the app adds a title and captions there.

## INFO_OVERLAY_COLORS

Colors: two or three accent colors that fit the brand tone, a different accent for each piece of information; no neon overload. Do not add any element that is not described above. Vertical 9:16.

## INFO_LINES_BASE

Use the attached image as the base and keep the photo, composition, person and product exactly the same.

## INFO_LINES_INTRO

Add a clean Korean infographic overlay (arrows, highlight circles, simple labels) with exactly these text lines and no other text, spelled exactly as written:

## INFO_LINES_STYLE

Large, legible, high-contrast text. Vertical 9:16.

## INFO_LINES_BAND

Place every graphic and text line inside the middle band of the frame (between {{INFO_GRAPHIC_BAND_TOP}}% and {{INFO_GRAPHIC_BAND_BOTTOM}}% of the height from the top). Keep the top {{INFO_GRAPHIC_BAND_TOP}}% and the bottom {{INFO_GRAPHIC_BAND_BOTTOM_FREE}}% free of graphics and text: the app adds a title and captions there.

## INFO_MOTION_LEGACY_TAIL

Start exactly on the first frame (the clean photo) and end exactly on the last frame (the same photo with the infographic). The infographic elements appear smoothly; keep the person and product unchanged. Text rule: the only text that may ever appear is the exact labels already visible in the last frame, and they fade in as finished labels (never letter by letter). Never show any other words, English text, headings, titles, check marks or logos at any moment of the video.

## INFO_MOTION_OPENING

Start exactly on the first frame (the clean photo) and end exactly on the last frame (the same photo with the finished graphics).

## INFO_MOTION_ORDER

The graphics build up in this order, each one growing, drawing or lighting itself in: {{order}}

## INFO_MOTION_CAMERA

One continuous camera move through the same 3D space: no cuts; at the end of each phase settle on a stable composition and hold it for about 0.4 seconds. Not a plain cross-fade and not a static zoom. Keep the person, product and background unchanged; never create new people or objects.

## INFO_MOTION_TEXT

No text at any moment: no letters, words, numbers, labels, captions or logos appear anywhere in the video, not even in the last frame. Eight seconds, 9:16, no lip sync.

## START_IMAGE_TAIL

Portrait 9:16 frame. Same product, same person, same place and lighting as the reference image where they appear. No added promotional copy or logos. Preserve visible existing product labels and packaging.

## STILL_IMAGE_TAIL

Portrait 9:16 photographic still, natural lighting, realistic. The same product, person, place and lighting as the reference image where they appear. No added promotional copy or new logos. Preserve visible existing product labels and packaging.

## SCENE_IMAGE_REFERENCE_1

Use reference image 1 for visible product identity, shape, materials and packaging details. Preserve existing product markings; do not invent branding. Do not copy its promotional text, captions, infographic blocks or card layout. Produce the requested photographic scene, not another advertisement card.

## SCENE_IMAGE_REFERENCE_2

Reference image 2 is the established photographic scene: preserve its person, clothing, setting, lighting and product appearance while changing only the action and framing requested for this shot.

## SCENE_IMAGE_REFERENCE_NONE

Establish a consistent photographic person, setting and lighting from the supplied style direction.

## SOURCE_IMAGE_IMMERSIVE_NOTE

Match the video visual system in the advertising background, typography and decorative elements. Preserve the actual product shape, packaging, existing label colors and supplied identity; do not recolor the product to fit the palette. Keep the original approved message and requested text unchanged.

## FLOW_CHECKLIST

Flow(https://labs.google/fx/tools/flow)에 AI Pro 구독 Google 계정으로 로그인되어 있는지 확인한다.
클립마다 새 프로젝트(또는 새 장면)를 열고 모델을 {{model}}(내보낸 suggestedModel)로 고른다.
화면 비율 9:16, 길이 8초, 해상도 1080p(선택지가 있을 때)로 설정한다.
시작 이미지(startImageFile)를 첫 프레임 또는 이미지 참조로 올린다.
프롬프트(prompt)를 수정 없이 그대로 붙여 넣고 생성한다.
완성되면 시작 이미지와 같은 제품·인물·배경인지, 계획에 없는 글자·로고가 생기지 않았는지 화면에서 직접 확인한다.
확인한 클립을 outputFile 이름으로 내려받는다(영상 한 편의 다운로드 확인은 사용자에게 한 번만 묻는다).
importCommand 로 앱에 업로드한다. 업로드가 끝나면 앱이 자동으로 다음 단계를 이어간다.

## FLOW_INFO_CHECKLIST_NO_TEXT

글자 없는 방식의 설명 컷은 CLEAN 이미지 → INFO 이미지 → 전환 영상 순서로 만든다. 이 컷의 INFO 이미지에는 글자·숫자·라벨이 없어야 하며(글자는 앱이 콜아웃으로 그린다) 앱이 업로드 때 글자 유무를 자동 검사한다.

## FLOW_INFO_CHECKLIST_LINES

지정 문구 방식의 설명 컷은 CLEAN 이미지 → 화살표·연결선·라벨을 완성한 INFO 이미지 → 전환 영상 순서로 만든다. 이 컷의 INFO 이미지 글자는 넣을 문구(infoLines)와 같아야 하며 앱이 업로드 때 자동 대조한다.

## FLOW_INFO_CHECKLIST_EXPLAINER

번들·화면의 '빨간 외곽선'·'흰 발광선'은 기존 강조 종류 이름이며 색을 강제하는 지시가 아니다. 실제 색과 굵기는 INFO·영상 프롬프트의 대비 기준을 따른다.

혼합형 설명 장면(I1~I3)은 설명 세계 CLEAN 이미지 → 계획한 최종 상태와 인포그래픽을 완성한 INFO 이미지 → 두 이미지를 잇는 전환 영상 순서로 만든다. 실사 시작 이미지는 참조로 첨부하지 않는다. INFO에는 설명에 필요한 강조와 한글 라벨만 넣고, 브랜드 기본색 외에도 읽기 위한 대비색을 쓸 수 있다. INFO의 글자는 번들의 '넣을 문구'와 정확히 같아야 하며 앱이 업로드 때 자동 대조한다. 넣을 문구가 없는 예전 혼합형 장면은 글자·숫자·이름표 없이 글자 유무를 검사한다. CLEAN·INFO는 사용자가 확인한 뒤 영상 단계로 넘어가며, 이미지 검사 통과는 영상 중간 프레임의 글자 검증이 아니다.

## FLOW_HYBRID_EYE_CHECK

눈으로 확인(앱이 자동 검사하지 않음): 설명 장면에는 사람·손·얼굴이 없고, 실사에는 사람과 상황이 보여야 한다. 비교는 겉이 똑같은 상태에서 시작하며 실사 얼굴은 프레임 안, 휴대폰·모니터는 화면이 꺼져 있어야 한다. 영상을 재생하고 편집에 쓸 구간의 시작·중간·끝과 글자 등장/카메라 전환 순간을 확인한다: 한글 변형·추가 문구·화면 밖 잘림·자막 겹침이 없는지, 선과 라벨이 같은 대상을 가리키는지, 동작·그래픽 순서와 INFO 최종 상태가 맞는지 본다. 각 구간만으로 설명이 이해되는지도 확인하고 실제 등장·완료 시각을 기록한다. 문제가 있으면 업로드·다음 제작을 보류하고 보고한다. 이 기록으로 앱이 자동 재편집하지 않으며, 재생성·크레딧 사용은 사용자 승인 범위에서만 한다.

## VEO_HF_INFO_IMAGE

Use the supplied CLEAN image as the reference for the same clay-white 3D objects, materials, lighting and scene. Create the final object state for this explanation: {{scene}}
Planned actions and final state: {{actions}}
Build the planned 3D explanatory graphics in full: {{veoGraphics}}
Use the necessary supported cutaways, exploded structure, translucent layers, contours, structural guide lines, flow paths and direction arrows to make the structure, difference and direction understandable without text. Select the elements needed for this explanation and give them clear depth, perspective and target attachment. These structural graphics are required when the plan calls for them; keep decorative clutter and unsupported facts out.
Preserve the planned identity, colors and composition. Keep the contours, structural guides and flow indicators that explain the objects independently of wording. Exclude only the annotation graphics whose role is to connect a written label to its target, along with the text and label plate. Removing text must not remove the scene's structural explanation.
This INFO image is a text-free target for the base video. Do not draw letters, words, numbers, labels, label plates, empty label boxes, or leader lines, arrows, endpoint dots and highlights that directly connect a written label to its target. Do not invent replacement symbols. Those complete annotation groups are added later by the app. Keep the planned space for annotations clear without drawing placeholders. Keep the explanatory objects in the middle {{INFO_GRAPHIC_BAND_TOP}}–{{INFO_GRAPHIC_BAND_BOTTOM}}% of the frame and leave room for spoken captions. No people, hands or faces. Vertical 9:16.

## VEO_HF_MOTION

Start on the supplied CLEAN frame and finish in the supplied text-free INFO state. Create one continuous eight-second vertical 9:16 shot in the same clay-white 3D space.
Explanation and objects: {{scene}}
Planned object actions and final state: {{actions}}
Camera start, target, connected spatial route and final composition: {{camera}}
Planned 3D explanatory graphics: {{veoGraphics}}
Reveal the planned cutaways, contours, structural guide lines, flow paths and direction arrows in step with the object actions, and preserve the complete explanatory state in INFO. Keep the structure, difference and flow understandable without text. These guides and arrows explain the objects independently of labels and must not be removed with label connectors.
Preserve object identity, materials, colors and lighting. Move only to reveal the planned structure, difference, flow or scope. Use two or three connected viewpoints through the same physical space with coherent parallax, never an orbit just to keep moving. Use fast approaches or retreats selectively, not as a repeated pattern across adjacent scenes. Do not invent ingredients, quantities, anatomy or effects, and do not present a diagram as proof of an unsupported claim. Allow a stable, readable viewpoint when the later annotation will be read; no unplanned rotation, morphing, extra objects, scene cuts or slideshow zoom. Keep the planned annotation area clear throughout the shot.
No text, letters, numbers, labels, label plates, empty label boxes, or leader lines, arrows, endpoint dots and highlights that directly connect a written label to its target at any moment, including the final frame. Do not generate temporary or invented lettering. The app adds each complete annotation group after the base video is made. No speech, dialogue, lip sync, music or added logos. Do not add graphics that are absent from the object-level effects above.

## HF_LABEL_LAYER_RULES

1. 한 설명 라벨은 정확한 문구·라벨판·연결선·대상 끝점을 묶은 세트다. Veo/INFO에는 라벨용 글자·판·선·끝점을 중복해서 그리지 않는다. Veo 담당 3D 단면·분해·투명화·구조 윤곽선·가이드선·흐름 화살표는 설명 목적에 맞게 충분히 유지한다.
2. 한 영상의 주 라벨은 03 올리브 필 배지 한 가지로 통일한다. 진올리브 #3E4A22 바탕·흰색 #FFFDF5 글자·완전히 둥근 모서리, 아주 옅은 그림자 한 겹만 사용한다. 보조 정보가 꼭 필요한 라벨만 role=supporting으로 계획하고 판 없는 02 기술 콜아웃을 48px로 쓴다. 주 라벨을 보조 정보로 지정해 크기 제한을 피하지 않는다.
3. 주 라벨은 Pretendard Bold 64~72px(1080×1920 기준), 기본 68px·자간 −2%·왼쪽 정렬·숫자 고정폭이다. 한 줄이 원칙이며 16자를 넘을 때만 어절에서 줄을 나눈다. 승인된 문구·숫자·기호는 자르거나 바꾸지 않는다. 글자를 축소하지 말고 판을 넓히며 폭은 화면의 80%까지다. 그래도 맞지 않으면 배치를 다시 계획한다.
4. 한 줄 배지 높이는 글자 크기의 2배, 좌우 여백은 0.8em이다. 두 줄 예외는 각 행의 글자·행간과 세로 여백이 들어가도록 높이를 늘린다. 동시에 비교하는 배지는 같은 글자 크기·높이·윗선·안쪽 여백으로 정렬한다. 1개 라벨을 읽기 어려운 여러 판으로 쪼개지 않는다.
5. 연결선은 진올리브 5px 선 바깥에 흰색 2px 테두리를 둔다(전체 외곽선 폭 9px). 앵커에서 수직으로 내려온 뒤 배지 윗변 가운데까지 짧은 수평선으로 잇는 두 마디를 쓴다. 수평 길이는 최대 화면 폭 15%이며 배지 중심을 대상 가까이 배치해 화면 끝까지 돌아가지 않게 한다. 배지 모서리에 어정쩡하게 붙이거나 글자를 통과하지 않는다.
6. 앵커는 골드 #B09A60 속과 흰색 테두리를 가진 큰 점이다(1080 기준 반지름 13px·테두리 4px). 먼저 대상을 짚고 선이 연결된 뒤 배지는 앵커 방향의 윗변에서 자라듯 0.4초 동안 등장한다. 글자는 완성된 문구 전체가 함께 페이드 인한다. 글자 와이프·한 글자씩 타이핑·글자 변형은 하지 않는다. 읽는 동안 흔들림·회전·축소를 주지 않는다.
7. 라벨별 infoLines 인덱스, 대상과 앵커, 판 위치, 등장·완성·읽기·퇴장 시점, 실제 원본 8초에서의 위치를 계획한다. 좌표는 source_1080x1920의 0~1, tracking=planned다. 실제 Veo 원본의 대상과 대조해 조정하며 예정 좌표를 자동 추적이나 관찰 결과로 표시하지 않는다.
8. 라벨은 좌우 4% 안전 여백과 자막 영역 위에 놓는다. 라벨판 아래는 화면 높이 69% 이내를 기준으로 하고, 대상·다른 라벨·내레이션 자막을 가리지 않는다. 앵커와 판을 무조건 중앙으로 몰지 말고 비교 대상별 공간과 연결선 길이를 함께 확인한다. 계획된 라벨이 최종 선택한 컷에서 완성된 상태로 최소 1초 이상 읽혀야 한다.
9. 자막은 화면 아래 끝이 아닌 1080 기준 y=1360~1568 영역에 둔다. 일반 구절 64px, 명시된 핵심 구절만 86px와 옅은 노랑 #FFF8CC로 강조한다. 흰 글자·진한 올리브 외곽선/그림자로 읽히게 하고 긴 불투명 바는 쓰지 않는다. 설명 컷에서는 일반 자막을 유지하며 라벨과 같은 문구를 겹쳐 강조하지 않는다.
10. 컷 전환 자체가 내레이션을 끊는 이유가 되지 않는다. 실제 발화와 문장 경계의 무음만 확인해 일반 문장 사이 0.2~0.35초, 의도한 강조 뒤 0.45~0.6초부터 배치한다. 라벨 읽기는 대사와 겹쳐 확보하고 8초 원본 소진이나 목표 길이 채우기를 위해 무음을 추가하지 않는다. 문장 내부 호흡·발음·말끝·원문은 보존한다. 물체 동작 싱크 때문에 조정이 불가능하면 그 구간을 경고로 남긴다.
11. 원본 오디오는 최종 합성에 섞지 않는다. 원본 시간과 편집 컷의 읽기 시작 시각을 연결해 라벨·선·앵커·음성·자막을 맞춘다. 설명 컷의 카메라/배속 효과가 좌표를 바꾸면 같은 변환을 적용하거나 해당 효과를 빼고 보고한다.
12. 최종 360×640 정상 재생에서 글자가 읽히고 대상이 명확한지 확인한다. 등장·퇴장·카메라 이동 때 잘림·겹침·선 끝 이탈도 본다. 정지 시안과 큰 화면 검사를 모바일 영상 검증으로 대신하지 않는다. 검사하지 않은 실제 생성 영상은 미검증으로 남긴다.

## FLOW_INFO_CHECKLIST_HF

설명 컷은 Veo 3.1 Lite·9:16·8초·x1을 실제 화면에서 확인한다. 사용자 확인을 받은 CLEAN·글자 없는 INFO를 업로드한다. INFO의 구조 윤곽선·가이드선·흐름 화살표는 유지하고, 글자·라벨판·문구용 연결선·끝점은 제외한다. 오류는 보고하고 임의 우회·재생성하지 않는다. 번들의 infoLines와 labelLayer는 HyperFrames 합성용이며 Veo에 전달하지 않는다. 좌표와 시각은 계획값으로, 실제 원본과 대조해야 한다. 앱이 원본 시각과 컷 구간을 대조해 03 라벨을 자동 합성한다. 계획 좌표는 자동 추적 결과가 아니며, 실제 유료 생성은 승인된 범위에서만 진행한다.
