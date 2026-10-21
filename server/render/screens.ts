import type { CutMechanism, CutScreen } from "../../shared/video-script";

// 폰 화면·작용 원리 템플릿(2026-10-21, higgsfield-remake 규칙 반영 ③).
// 기준 구현 ~/.claude/skills/higgsfield-remake/scripts/screens.py 의 HTML/CSS/GSAP 를 그대로 옮겼다(디자인 무변경).
// 바꾼 것: 글꼴(Noto Sans KR 웹 글꼴 → 저장소 동봉 Pretendard, 오프라인 렌더), 효과음 목록 없음(이번 단위 범위 밖),
// 입자 흔들림 난수(파이썬 random(7) → 같은 씨앗의 mulberry32), 모델이 쓴 글은 HTML 이스케이프.
// 설계 크기 360x640(폰) → 3배(1080x1920). 작용 원리 위쪽은 360x318 → 3배(1080x954), 아래 966~1920 은 실사(조립이 ffmpeg 로 붙인다).

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (text: string) => text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
// 시각 숫자: 파이썬 f"{x:.3f}" 와 같은 자리수(끝 0 은 GSAP 에 영향 없음).
const f3 = (value: number) => value.toFixed(3);
const num = (value: number) => String(Math.round(value * 1000) / 1000);

const STATUS = '<div class="status"><span>오후 9:41</span><span class="sr"></span></div>';
const MAG =
  '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#888" stroke-width="2.2"/><path d="M15 15l5.5 5.5" stroke="#888" stroke-width="2.2"/></svg>';
const SRCH =
  '<svg width="17" height="17" viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#222" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="#222" stroke-width="2"/></svg>';
const CART =
  '<svg width="19" height="19" viewBox="0 0 24 24"><path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7" fill="none" stroke="#222" stroke-width="1.8"/><circle cx="9.5" cy="19" r="1.5" fill="#222"/><circle cx="17" cy="19" r="1.5" fill="#222"/></svg>';
const MIC =
  '<svg width="17" height="17" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="#03c75a" stroke-width="2"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="#03c75a" stroke-width="2"/></svg>';
const LENS =
  '<svg width="17" height="17" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="3" fill="none" stroke="#03c75a" stroke-width="2"/><circle cx="12" cy="12.5" r="3.5" fill="none" stroke="#03c75a" stroke-width="2"/></svg>';
const keys = (chars: string) =>
  Array.from(chars)
    .map((c) => `<span class="k">${c}</span>`)
    .join("");
const KB = `<div class="kb"><div class="row">${keys("ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ")}</div><div class="row">${keys("ㅁㄴㅇㄹㅎㅗㅓㅏㅣ")}</div><div class="row"><span class="k w">&#8679;</span>${keys("ㅋㅌㅊㅍㅠㅜㅡ")}<span class="k w">&#9003;</span></div><div class="row"><span class="k w">!#1</span><span class="k w">한/영</span><span class="k sp">스페이스</span><span class="k w">.</span><span class="k w">검색</span></div></div>`;

// n개 요소를 차례로 하나만 보이게(타이핑·숫자 변화·카운트다운). seek 안전한 tl.set.
function steps(js: string[], prefix: string, n: number, t0: number, dt: number): void {
  for (let k = 0; k < n; k++) {
    js.push(`tl.set("${prefix}${k}",{opacity:1},${f3(t0 + k * dt)});`);
    if (k) js.push(`tl.set("${prefix}${k - 1}",{opacity:0},${f3(t0 + k * dt)});`);
  }
}
function wrap(sid: string, cls: string, s: number, d: number, track: number, body: string) {
  return `<div id="${sid}" class="clip full scr ${cls}" data-layout-allow-overlap data-start="${num(s)}" data-duration="${num(d)}" data-track-index="${track}"><div class="phone">${body}</div></div>`;
}

// --- 템플릿 data(파이썬 EXAMPLES 와 같은 모양) ------------------------------------------------------------------
export type SearchData = {
  readonly query: string;
  readonly suggestions: readonly string[];
  readonly highlight: readonly number[];
};
export type ChatMessage = {
  readonly who: "me" | "cs";
  readonly text: string;
  readonly time: string;
};
export type ChatData = {
  readonly partner: string;
  readonly avatar: string;
  readonly messages: readonly ChatMessage[];
  readonly zoom: {
    readonly time: string;
    readonly before: string;
    readonly mark: string;
    readonly after: string;
  };
};
export type ShopItem = {
  readonly img: string;
  readonly name: string;
  readonly price: string;
  readonly bad: boolean;
};
export type ShopData = {
  readonly query: string;
  readonly stamp: string;
  readonly items: readonly ShopItem[];
};
export type PriceData = {
  readonly store: string;
  readonly img: string;
  readonly title: string;
  readonly pct: string;
  readonly listPrice: string;
  readonly rows: readonly {
    readonly label: string;
    readonly value: string;
    readonly red: boolean;
  }[];
  readonly finalSteps: readonly string[];
  readonly coupon: string;
};
export type DocData = {
  readonly source: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly zoomBefore: string;
  readonly mark: string;
  readonly zoomAfter: string;
};
export type MechanismData = {
  readonly bg: string;
  readonly chips: readonly string[];
  readonly counter: {
    readonly label: string;
    readonly steps: readonly string[];
    readonly unit: string;
  };
  readonly result: string;
};
export type ScreenTemplate =
  | { readonly kind: "search"; readonly data: SearchData }
  | { readonly kind: "chat"; readonly data: ChatData }
  | { readonly kind: "shop"; readonly data: ShopData }
  | { readonly kind: "price"; readonly data: PriceData }
  | { readonly kind: "doc"; readonly data: DocData };

// --- 대본 칸(screen) → 템플릿 data 매퍼. 칸의 뜻은 shared/video-script.ts CutScreenSchema 주석과 같다. ---------------
const strip = (text: string, prefix: RegExp) => text.replace(prefix, "").trim();
const ME = /^나\s*[:：]\s*/u;
const PARTNER = /^상대\s*[:：]\s*/u;
const FAKE = /^가품\s*[:：]\s*/u;
// 강조 구절을 둘러싼 앞뒤로 나눈다(없으면 앞 = 글 전체, 표시는 강조 구절만 박스).
function around(text: string, mark: string): { before: string; mark: string; after: string } {
  const at = mark ? text.indexOf(mark) : -1;
  if (at < 0) return { before: "", mark: mark || text, after: "" };
  return { before: text.slice(0, at), mark, after: text.slice(at + mark.length) };
}
export function screenTemplate(screen: CutScreen, image: string): ScreenTemplate {
  switch (screen.kind) {
    case "none":
    case "search": {
      const suggestions = screen.lines.slice(0, 8);
      const hit = suggestions.findIndex(
        (line) =>
          screen.highlight !== "" && (line === screen.highlight || line.includes(screen.highlight)),
      );
      return {
        kind: "search",
        data: {
          query: screen.query || screen.title,
          suggestions,
          highlight: hit >= 0 ? [hit] : [],
        },
      };
    }
    case "chat": {
      const messages: ChatMessage[] = screen.lines.map((line) => ({
        who: ME.test(line) ? "me" : "cs",
        text: strip(strip(line, ME), PARTNER),
        time: "",
      }));
      const answers = messages.filter((message) => message.who === "cs");
      const target =
        answers.find(
          (message) => screen.highlight !== "" && message.text.includes(screen.highlight),
        ) ??
        answers.at(-1) ??
        messages.at(-1);
      return {
        kind: "chat",
        data: {
          partner: screen.title || "고객센터",
          avatar: "CS",
          messages,
          zoom: { time: "", ...around(target?.text ?? "", screen.highlight) },
        },
      };
    }
    case "shop":
      return {
        kind: "shop",
        data: {
          query: screen.query,
          stamp: screen.highlight,
          items: screen.lines.slice(0, 4).map((line, index) => ({
            img: image,
            name: strip(line, FAKE),
            price: screen.numbers[index] ?? "",
            bad: FAKE.test(line),
          })),
        },
      };
    case "price": {
      const [title = "", ...rest] = screen.lines;
      const [listPrice = "", finalPrice = "", pct = ""] = screen.numbers;
      return {
        kind: "price",
        data: {
          store: screen.title,
          img: image,
          title,
          pct,
          listPrice,
          rows: rest.map((row) => {
            const [label = "", value = ""] = row.split("|").map((part) => part.trim());
            return { label, value, red: value.startsWith("-") };
          }),
          finalSteps: [listPrice, finalPrice].filter((value) => value !== ""),
          coupon: screen.highlight,
        },
      };
    }
    case "doc": {
      const [title = "", ...lines] = screen.lines;
      const holder = lines.find(
        (line) => screen.highlight !== "" && line.includes(screen.highlight),
      );
      const zoom = around(holder ?? "", screen.highlight);
      return {
        kind: "doc",
        data: {
          source: screen.title,
          title,
          lines,
          zoomBefore: zoom.before,
          mark: zoom.mark,
          zoomAfter: zoom.after,
        },
      };
    }
    default:
      return screen.kind satisfies never;
  }
}
export function mechanismTemplate(mechanism: CutMechanism, background: string): MechanismData {
  return {
    bg: background,
    chips: mechanism.chips.slice(0, 2),
    counter: {
      label: mechanism.counterLabel,
      steps: mechanism.counterSteps,
      unit: mechanism.counterUnit,
    },
    result: mechanism.result,
  };
}

// ---------------------------------------------------------------- 검색
function search(sid: string, s: number, d: number, data: SearchData, js: string[]) {
  const q = Array.from(data.query);
  const typed: string[] = [];
  for (let i = 1; i <= q.length; i++)
    if (q[i - 1] !== " " || i === q.length) typed.push(q.slice(0, i).join(""));
  const ty = typed
    .map((x, k) => `<span class="ty" id="${sid}t${k}">${esc(x)}<i class="cur"></i></span>`)
    .join("");
  const hi = new Set(data.highlight);
  const query = esc(data.query);
  const lis = data.suggestions
    .slice(0, 8)
    .map(
      (x, k) =>
        `<li class="${hi.has(k) ? "hi" : ""}">${MAG}${query}&nbsp;<b>${esc(x)}</b><span class="arr">&#8598;</span></li>`,
    )
    .join("");
  steps(js, `#${sid}t`, typed.length, s + 0.05, 0.1);
  const tList = s + 0.05 + typed.length * 0.1;
  js.push(
    `tl.fromTo("#${sid} li",{opacity:0},{opacity:1,duration:.05,stagger:.045},${f3(tList)});`,
  );
  const tDim = Math.min(s + d - 0.6, tList + 0.55);
  js.push(
    `tl.fromTo("#${sid} li.hi",{color:"#222"},{color:"#ff7a1a",duration:.1},${f3(tDim - 0.25)});`,
  );
  js.push(`tl.fromTo("#${sid} .dim",{opacity:0},{opacity:1,duration:.15},${f3(tDim)});`);
  js.push(
    `tl.fromTo("#${sid} .pop",{scale:.85,opacity:0},{scale:1,opacity:1,duration:.15},${f3(tDim)});`,
  );
  return `${STATUS}<div class="top"><span class="back">&#8592;</span><span class="q">${ty}</span><span class="clr">&#10005;</span></div><div class="tabs"><b>최근검색</b><span>자동완성</span></div><ul>${lis}</ul><div class="foot"><span>자동저장 끄기 · 도움말</span><span class="g">${MIC}${LENS}</span></div>${KB}<div class="dim"></div><div class="pop">${query}<i class="cur"></i></div>`;
}

// ---------------------------------------------------------------- 채팅
function chat(sid: string, s: number, d: number, data: ChatData, js: string[]) {
  let h = "";
  const msgs = data.messages;
  const gap = Math.min(0.3, Math.max(0.18, (d - 0.9) / Math.max(1, msgs.length)));
  let firstCs = true;
  msgs.forEach((m, k) => {
    if (m.who === "me")
      h += `<div class="msg me m${k}"><span class="t"><small>읽음</small>${esc(m.time)}</span><div class="b">${esc(m.text)}</div></div>`;
    else {
      const av = firstCs
        ? `<div class="av">${esc(data.avatar)}</div>`
        : '<div class="av" style="visibility:hidden"></div>';
      const nm = firstCs ? `<span class="who">${esc(data.partner)}</span>` : "";
      firstCs = false;
      h += `<div class="msg m${k}">${av}<div class="col">${nm}<div class="b">${esc(m.text)}</div></div><span class="t">${esc(m.time)}</span></div>`;
    }
    js.push(
      `tl.fromTo("#${sid} .m${k}",{opacity:0,y:12},{opacity:1,y:0,duration:.12},${f3(s + 0.05 + k * gap)});`,
    );
  });
  const pt = num(Math.min(s + 0.05 + msgs.length * gap + 0.1, s + d - 0.5));
  js.push(`tl.fromTo("#${sid} .dim",{opacity:0},{opacity:1,duration:.15},${pt});`);
  js.push(
    `tl.fromTo("#${sid} .cpop",{scale:.8,opacity:0},{scale:1,opacity:1,duration:.18,ease:"back.out(1.6)"},${pt});`,
  );
  js.push(
    `tl.fromTo("#${sid} .hl",{boxShadow:"0 0 0 0 rgba(255,138,30,0)"},{boxShadow:"0 0 0 6px rgba(255,138,30,.35)",duration:.25,yoyo:true,repeat:3},${f3(Number(pt) + 0.2)});`,
  );
  const z = data.zoom;
  const partner = esc(data.partner);
  return `${STATUS}<div class="head"><span class="back">&#8592;</span><span class="nm">${partner}<small>평일 10:00~18:00 상담</small></span><span class="hic">${SRCH}<span>&#9776;</span></span></div><div class="notice">&#128226; 상담 가능 시간에 순차적으로 답변드려요</div><div class="date">2026년 10월 14일 화요일</div>${h}<div class="input"><span>＋</span><div class="box">메시지 입력</div><span>&#9786;</span><span class="send">전송</span></div><div class="dim"></div><div class="cpop"><small>${partner}${z.time ? ` · ${esc(z.time)}` : ""}</small>${esc(z.before)}<span class="hl">${esc(z.mark)}</span>${esc(z.after)}</div>`;
}

// ---------------------------------------------------------------- 쇼핑 목록
function shop(sid: string, s: number, d: number, data: ShopData, js: string[], imgDir: string) {
  let h = "";
  for (const it of data.items)
    h += `<div class="it${it.bad ? " bad" : ""}"><div class="th">${it.img ? `<img src="${imgDir}/${esc(it.img)}">` : ""}</div><div class="inf"><p>${esc(it.name)}</p><div class="pp"><b>${esc(it.price)}</b></div><small><em>&#9733;</em>4.7 · 리뷰 1,024 · 무료배송</small><small class="sn"></small></div><span class="hrt">&#9825;</span>${it.bad ? "" : '<i class="shade"></i>'}</div>`;
  js.push(
    `tl.fromTo("#${sid} .list",{y:0},{y:-70,duration:${num(Math.round(Math.min(d, 1.2) * 100) / 100)},ease:"power1.inOut"},${num(s)});`,
  );
  const t = s + Math.min(0.6, d * 0.4);
  // 목록이 스크롤(transform)되는 동안엔 가품 줄만 dim 위로 못 띄움 → 가품 아닌 줄과 상단만 따로 어둡게
  js.push(
    `tl.fromTo("#${sid} .shade, #${sid} .hdim",{opacity:0},{opacity:1,duration:.15},${f3(t)});`,
  );
  js.push(
    `tl.fromTo("#${sid} .bad",{outlineColor:"rgba(229,45,39,0)"},{outlineColor:"rgba(229,45,39,1)",duration:.1},${f3(t)});`,
  );
  if (data.stamp) {
    js.push(
      `tl.fromTo("#${sid} .stamp",{scale:2.6,opacity:0,rotation:16},{scale:1,opacity:1,rotation:8,duration:.16,ease:"power4.in"},${f3(t + 0.15)});`,
    );
    js.push(
      `tl.fromTo("#${sid} .phone",{x:0},{x:3,duration:.04,yoyo:true,repeat:5},${f3(t + 0.31)});`,
    );
  }
  return `${STATUS}<div class="shead"><span class="back">&#8592;</span><span class="sq">${SRCH}<span>${esc(data.query)}</span></span><span class="ic">${CART}</span></div><div class="tabs"><b>전체</b><span>가격비교</span><span>쇼핑몰</span><span>해외직구</span></div><div class="sort"><span>랭킹순 ▾</span><span>필터</span><span class="cnt">상품 1,284개</span></div><div class="list">${h}</div><div class="hdim"></div>${data.stamp ? `<div class="stamp">${esc(data.stamp)}</div>` : ""}`;
}

// ---------------------------------------------------------------- 가격·할인 상세
function price(sid: string, s: number, _d: number, data: PriceData, js: string[], imgDir: string) {
  js.push(`tl.fromTo("#${sid} .page",{y:40},{y:0,duration:.35,ease:"power2.out"},${num(s)});`);
  js.push(
    `tl.fromTo("#${sid} .rw",{opacity:0,x:-12},{opacity:1,x:0,duration:.12,stagger:.16},${num(s + 0.25)});`,
  );
  const fv = data.finalSteps;
  steps(js, `#${sid} .fv`, fv.length, s + 0.72, 0.07);
  js.push(`tl.fromTo("#${sid} .box",{scaleX:0},{scaleX:1,duration:.18},${num(s + 1.0)});`);
  const tm = ["02:14:37", "02:14:36", "02:14:35", "02:14:34"];
  steps(js, `#${sid} .tm`, tm.length, s, 0.8);
  js.push(
    `tl.to("#${sid} .cbtn",{scale:1.12,duration:.2,yoyo:true,repeat:5,ease:"sine.inOut"},${num(s + 1.2)});`,
  );
  const rows = data.rows
    .map(
      (r) =>
        `<div class="rw${r.red ? " red" : ""}"><span>${esc(r.label)}</span><span>${esc(r.value)}</span></div>`,
    )
    .join("");
  const fvs = fv.map((v, k) => `<span class="fv fv${k}">${esc(v)}</span>`).join("");
  const tms = tm.map((v, k) => `<span class="tmv tm${k}">${v}</span>`).join("");
  return `${STATUS}<div class="hdr"><span class="bk">&#8592;</span><span class="nm">${esc(data.store)}</span><span class="ic">${SRCH}</span><span class="ic">${CART}<b>2</b></span></div><div class="page"><div class="img">${data.img ? `<img src="${imgDir}/${esc(data.img)}">` : ""}<span class="dot">1 / 8</span></div><div class="store"><i></i>${esc(data.store)} · 톡톡문의<span class="st"><em>&#9733;</em> 4.8 · 리뷰 2,184</span></div><div class="ttl">${esc(data.title)}</div><div class="pr"><span class="pct">${esc(data.pct)}</span><span class="now">${esc(fv.at(-1) ?? "")}</span><s>${esc(data.listPrice)}</s></div><div class="calc">${rows}<div class="fin"><span>최종 혜택가<small></small></span><b><i class="box"></i>${fvs}</b></div></div><div class="cpn"><span>&#127915;</span><span class="t">${esc(data.coupon || "할인코드 받기")}</span><span class="tms">${tms}</span><span class="cbtn">받기</span></div><div class="chips"></div><div class="dlv"></div></div><div class="fab" style="bottom:112px">&#128172;</div><div class="fab" style="bottom:66px">TOP</div><div class="pbar"><div class="h">&#9825;<small>2.1만</small></div><div class="cart">장바구니</div><div class="buy">구매하기</div></div>`;
}

// ---------------------------------------------------------------- 문서(논문·성분표·기사)
function doc(sid: string, s: number, d: number, data: DocData, js: string[]) {
  const lines = data.lines.map((x, k) => `<p class="l${k}">${esc(x)}</p>`).join("");
  js.push(`tl.fromTo("#${sid} .page",{y:30},{y:-20,duration:${num(d)},ease:"none"},${num(s)});`);
  const t = s + Math.min(0.7, d * 0.35);
  js.push(`tl.fromTo("#${sid} .dim",{opacity:0},{opacity:1,duration:.15},${f3(t)});`);
  js.push(
    `tl.fromTo("#${sid} .zpop",{scale:.7,opacity:0},{scale:1,opacity:1,duration:.2,ease:"back.out(1.6)"},${f3(t)});`,
  );
  js.push(
    `tl.fromTo("#${sid} .zpop .mk",{backgroundSize:"0% 100%"},{backgroundSize:"100% 100%",duration:.3},${f3(t + 0.25)});`,
  );
  const bars = [78, 74, 52, 41].map((h) => `<i style="height:${h}%"></i>`).join("");
  return `${STATUS}<div class="dhead"><span class="back">&#8592;</span><span class="src">${esc(data.source)}</span><span>&#8942;</span></div><div class="page"><div class="kind">Research article</div><h1>${esc(data.title)}</h1><div class="meta"></div><div class="hlt"><b>Highlights</b></div><div class="abs">Abstract</div>${lines}<div class="fig"><div class="bars">${bars}</div><small>Fig. 1.</small></div></div><div class="dim"></div><div class="zpop">${esc(data.zoomBefore)}<span class="mk">${esc(data.mark)}</span>${esc(data.zoomAfter)}</div>`;
}

export function renderScreen(
  template: ScreenTemplate,
  sid: string,
  s: number,
  d: number,
  js: string[],
  track: number,
  imgDir = "assets",
): string {
  switch (template.kind) {
    case "search":
      return wrap(sid, "search", s, d, track, search(sid, s, d, template.data, js));
    case "chat":
      return wrap(sid, "chat", s, d, track, chat(sid, s, d, template.data, js));
    case "shop":
      return wrap(sid, "shop", s, d, track, shop(sid, s, d, template.data, js, imgDir));
    case "price":
      return wrap(sid, "price", s, d, track, price(sid, s, d, template.data, js, imgDir));
    case "doc":
      return wrap(sid, "doc", s, d, track, doc(sid, s, d, template.data, js));
    default:
      return template satisfies never;
  }
}

// 파이썬 random.Random(7) 대신 같은 씨앗의 결정적 난수(입자 위치 흔들림 ±11px·±9px).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PATH: readonly (readonly [number, number])[] = [
  [70, 88],
  [95, 105],
  [120, 118],
  [150, 122],
  [178, 132],
  [200, 150],
  [222, 168],
  [240, 190],
  [228, 214],
  [200, 226],
  [170, 232],
  [140, 240],
  [112, 252],
  [96, 272],
];
const RINGS: readonly (readonly [number, number, number])[] = [
  [150, 122, 26],
  [222, 168, 30],
  [140, 240, 24],
];
// ---------------------------------------------------------------- 작용 원리 (위쪽 절반)
export function renderMechanism(
  sid: string,
  s: number,
  d: number,
  data: MechanismData,
  js: string[],
  track: number,
  imgDir = "assets",
): string {
  const rg = mulberry32(7);
  const dots = PATH.flatMap(([x, y], i) =>
    [0, 1, 2].map(
      () =>
        `<i class="p g${i}" style="left:${Math.round(x + (rg() - 0.5) * 22)}px;top:${Math.round(y + (rg() - 0.5) * 18)}px;opacity:0"></i>`,
    ),
  ).join("");
  const rings = RINGS.map(
    ([x, y, r]) =>
      `<i class="ring" style="left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px"></i>`,
  ).join("");
  const t1 = s + 0.1;
  const t2 = s + Math.round(d * 0.36 * 100) / 100;
  const t3 = s + Math.round(d * 0.68 * 100) / 100;
  js.push(
    `tl.fromTo("#${sid} .bg",{scale:1},{scale:1.18,duration:${num(d)},ease:"none"},${num(s)});`,
  );
  js.push(`tl.fromTo("#${sid} .c1",{opacity:0,x:-20},{opacity:1,x:0,duration:.2},${num(t1)});`);
  PATH.forEach((_, i) => {
    js.push(
      `tl.to("#${sid} .g${i}",{opacity:.95,duration:.12},${f3(t1 + 0.15 + (i * (t2 - t1)) / PATH.length)});`,
    );
  });
  js.push(
    `tl.to("#${sid} .p",{y:"+=4",x:"+=3",duration:.5,yoyo:true,repeat:${Math.floor(d / 0.5)},ease:"sine.inOut"},${num(t1)});`,
  );
  js.push(
    `tl.fromTo("#${sid} .ring",{scale:.3,opacity:0},{scale:1,opacity:1,duration:.3,stagger:.15,ease:"back.out(2)"},${num(t2)});`,
  );
  js.push(`tl.fromTo("#${sid} .c2",{opacity:0,x:-20},{opacity:1,x:0,duration:.2},${num(t2)});`);
  js.push(`tl.fromTo("#${sid} .cnt",{opacity:0,y:-10},{opacity:1,y:0,duration:.2},${num(t2)});`);
  const cnt = data.counter;
  steps(js, `#${sid} .v`, cnt.steps.length, t2 + 0.1, 0.08);
  js.push(
    `tl.fromTo("#${sid} .res",{scale:.4,opacity:0},{scale:1,opacity:1,duration:.25,ease:"back.out(2.4)"},${num(t3)});`,
  );
  js.push(
    `tl.to("#${sid} .res",{scale:1.06,duration:.25,yoyo:true,repeat:${Math.max(1, Math.floor((d - (t3 - s)) / 0.25))},ease:"sine.inOut"},${num(t3 + 0.3)});`,
  );
  const vals = cnt.steps.map((v, k) => `<span class="v v${k}">${esc(v)}</span>`).join("");
  const [c1 = "", c2 = ""] = data.chips;
  const chip = (cls: string, n: number, text: string) =>
    text ? `<div class="chip ${cls}"><i>${n}</i>${esc(text)}</div>` : "";
  const counter =
    cnt.steps.length > 0 || cnt.label
      ? `<div class="cnt"><small>${esc(cnt.label)}</small><b>${vals}<span class="u">${esc(cnt.unit)}</span></b></div>`
      : "";
  return `<div id="${sid}" class="clip half top mech" data-start="${num(s)}" data-duration="${num(d)}" data-track-index="${track}"><div class="mp">${data.bg ? `<img class="bg" src="${imgDir}/${esc(data.bg)}">` : ""}<div class="veil"></div>${dots}${rings}${chip("c1", 1, c1)}${chip("c2", 2, c2)}${counter}<div class="res">${esc(data.result)} &#10140;</div></div></div>`;
}

const FONT_FAMILY = "ScreenFont";
// 파이썬 BASE_CSS 중 이 컴포지션이 쓰는 부분 + 동봉 글꼴.
const baseCss = `@font-face{font-family:${FONT_FAMILY};src:url('assets/screen-medium.ttf') format('truetype');font-weight:100 600;font-display:block}
@font-face{font-family:${FONT_FAMILY};src:url('assets/screen-bold.ttf') format('truetype');font-weight:700 900;font-display:block}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:#000}
body{font-family:${FONT_FAMILY},sans-serif}
#root{position:relative;width:1080px;height:1920px;background:#000;overflow:hidden}
.full{position:absolute;left:0;top:0;width:1080px;height:1920px;object-fit:cover}
.half{position:absolute;left:0;width:1080px;height:954px;object-fit:cover;overflow:hidden}
.top{top:0}
`;

export const SCREEN_CSS = `
/* ===== 폰 화면 공통 ===== */
.scr{overflow:hidden;background:#fff}
.phone{position:absolute;left:0;top:0;width:360px;height:640px;transform:scale(3);transform-origin:0 0;background:#fff;color:#111;overflow:hidden;font-family:ScreenFont,sans-serif}
.dim{position:absolute;inset:0;background:rgba(0,0,0,.52);opacity:0;z-index:7}
.cur{display:inline-block;width:2px;height:19px;background:#2f6cf6;vertical-align:-3px;margin-left:1px}
.status{position:relative;height:24px;display:flex;justify-content:space-between;align-items:center;padding:0 14px;font-size:11.5px;font-weight:700;background:inherit;z-index:5}
.status .sr{font-size:10px}
.back{font-size:21px;margin-right:12px;color:#222}
/* 검색 */
.search .top{position:relative;height:50px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #eee}
.search .q{position:relative;flex:1;height:22px;font-size:17px;font-weight:700}
.search .ty{position:absolute;left:0;top:-2px;white-space:pre;opacity:0}
.search .clr{width:18px;height:18px;border-radius:50%;background:#ccc;color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center}
.search .tabs{display:flex;gap:16px;padding:8px 14px;font-size:12.5px;color:#888;border-bottom:1px solid #f3f3f3}
.search .tabs b{color:#111}
.search ul{list-style:none}
.search li{height:38px;display:flex;align-items:center;padding:0 14px;font-size:15.5px;letter-spacing:-.4px;color:#222}
.search li svg{width:15px;height:15px;margin-right:13px;flex:none}
.search li b{font-weight:800}
.search li .arr{margin-left:auto;color:#bbb;font-size:13px}
.search .foot{position:absolute;left:0;right:0;top:418px;height:40px;border-top:1px solid #eee;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-size:12.5px;color:#777;background:#fff}
.search .foot .g{display:flex;gap:14px}
.kb{position:absolute;left:0;right:0;bottom:0;height:182px;background:#d4d6dc;padding:8px 3px 4px}
.kb .row{display:flex;justify-content:center;gap:5px;margin-bottom:9px}
.kb .k{width:31px;height:36px;border-radius:5px;background:#fff;box-shadow:0 1px 0 #9a9ca2;display:flex;align-items:center;justify-content:center;font-size:17px}
.kb .k.w{width:46px;background:#adb1ba;font-size:13px}.kb .k.sp{width:150px}
.search .pop{position:absolute;left:30px;right:30px;top:150px;height:58px;background:#ececec;border:1px solid #d0d0d0;display:flex;align-items:center;padding:0 14px;font-size:27px;font-weight:700;letter-spacing:-.6px;box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:0;z-index:8}
.search .pop .cur{height:30px;width:2.5px}
/* 채팅 */
.chat .phone{background:#b9cbd8}
.chat .head{height:46px;display:flex;align-items:center;padding:0 12px}
.chat .nm{font-size:16px;font-weight:700;letter-spacing:-.4px}
.chat .nm small{display:block;font-size:10.5px;font-weight:400;color:#455}
.chat .hic{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:16px}
.chat .notice{margin:2px 10px 0;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,.85);font-size:11px;color:#333}
.chat .date{margin:9px auto 7px;width:max-content;padding:3px 12px;border-radius:12px;background:rgba(0,0,0,.18);color:#fff;font-size:11px}
.chat .msg{display:flex;gap:7px;padding:4px 10px;align-items:flex-end;opacity:0}
.chat .msg.me{justify-content:flex-end}
.chat .av{width:36px;height:36px;border-radius:14px;background:#7fd6bf;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;align-self:flex-start;flex:none}
.chat .col{display:flex;flex-direction:column;gap:4px;max-width:232px}
.chat .who{font-size:11.5px;color:#334}
.chat .b{padding:8px 11px;border-radius:4px 14px 14px 14px;background:#fff;font-size:14px;line-height:1.42;letter-spacing:-.3px;max-width:232px}
.chat .me .b{background:#ffe96b;border-radius:14px 4px 14px 14px}
.chat .t{font-size:9.5px;color:#556;white-space:nowrap;text-align:right}
.chat .t small{display:block;color:#c9a400;font-size:9px}
.chat .input{position:absolute;left:0;right:0;bottom:0;height:48px;background:#fff;display:flex;align-items:center;padding:0 12px;gap:10px;color:#999;font-size:13px}
.chat .input .box{flex:1;height:32px;border-radius:16px;background:#f2f2f2;display:flex;align-items:center;padding:0 12px}
.chat .input .send{color:#bbb;font-weight:700}
.chat .cpop{position:absolute;left:16px;right:16px;top:206px;padding:16px;border-radius:6px 20px 20px 20px;background:#fff;font-size:19px;line-height:1.45;letter-spacing:-.6px;box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;z-index:8}
.chat .cpop small{display:block;font-size:12px;color:#888;margin-bottom:6px}
.chat .hl{display:inline-block;padding:0 4px;border:3px solid #ff8a1e;border-radius:6px;font-weight:800}
/* 쇼핑 목록 */
.shead{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid #eee;background:#fff;position:relative;z-index:5}
.shead .sq{flex:1;height:34px;border-radius:17px;background:#f3f4f6;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:14.5px;font-weight:700}
.shead .ic{display:flex}
.shop .tabs{display:flex;gap:16px;padding:9px 14px;font-size:13px;color:#777;border-bottom:1px solid #f0f0f0;background:#fff;position:relative;z-index:5}
.shop .tabs b{color:#03a94d;border-bottom:2px solid #03a94d;padding-bottom:6px}
.shop .sort{display:flex;gap:12px;padding:7px 14px;font-size:11.5px;color:#555;background:#fafafa;position:relative;z-index:5}
.shop .sort .cnt{margin-left:auto;color:#999}
.shop .it{position:relative;display:flex;gap:11px;padding:11px 14px;border-bottom:1px solid #f2f2f2;outline:3px solid rgba(229,45,39,0);outline-offset:-4px;background:#fff}
.shop .th{width:100px;height:100px;border-radius:8px;overflow:hidden;flex:none;background:#f4f4f4}
.shop .th img{width:100%;height:100%;object-fit:cover}
.shop .inf{flex:1;min-width:0}
.shop .adl{display:inline-block;font-size:9.5px;color:#999;border:1px solid #ddd;border-radius:3px;padding:0 3px;margin-bottom:2px}
.shop .inf p{font-size:13.5px;line-height:1.35;color:#222;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.shop .pp{margin-top:3px;display:flex;align-items:baseline;gap:5px}
.shop .pc{color:#e52d27;font-weight:900;font-size:15px}
.shop .pp b{font-size:16.5px;font-weight:900}
.shop .inf small{display:block;font-size:10.5px;color:#888;margin-top:3px}
.shop .inf small em{font-style:normal;color:#f5a623}
.shop .inf .sn{color:#03a94d}
.shop .hrt{position:absolute;right:14px;bottom:12px;color:#bbb;font-size:15px}
.shop .bad{z-index:8}
.shop .shade{position:absolute;inset:0;background:rgba(0,0,0,.55);opacity:0;font-style:normal}
.shop .hdim{position:absolute;left:0;right:0;top:0;height:134px;background:rgba(0,0,0,.55);opacity:0;z-index:6}
.shop .stamp{position:absolute;right:22px;top:345px;padding:6px 14px;border:4px solid #e52d27;color:#e52d27;font-weight:900;font-size:38px;border-radius:8px;background:rgba(255,255,255,.88);opacity:0;z-index:9}
/* 가격 */
.price .status{position:absolute;left:0;right:0;top:0;background:#fff;z-index:5}
.price .hdr{position:absolute;left:0;right:0;top:24px;height:44px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid #f0f0f0;z-index:5}
.price .hdr .bk{font-size:21px}.price .hdr .nm{flex:1;font-size:14px;font-weight:700;letter-spacing:-.3px}
.price .hdr .ic{position:relative;margin-left:6px;display:flex}
.price .hdr .ic b{position:absolute;right:-7px;top:-5px;min-width:13px;height:13px;border-radius:7px;background:#e52d27;color:#fff;font-size:8.5px;line-height:13px;text-align:center}
.price .page{position:absolute;left:0;right:0;top:68px}
.price .img{position:relative;height:150px;background:#eeeeec;overflow:hidden}
.price .img img{width:100%;height:230px;object-fit:cover;object-position:50% 45%}
.price .img .dot{position:absolute;right:10px;bottom:8px;padding:1px 8px;border-radius:9px;background:rgba(0,0,0,.45);color:#fff;font-size:10px}
.price .store{display:flex;align-items:center;gap:6px;padding:10px 14px 0;font-size:11.5px;color:#555}
.price .store i{width:18px;height:18px;border-radius:50%;background:#7fd6bf;color:#fff;font-style:normal;font-size:6.5px;font-weight:900;display:flex;align-items:center;justify-content:center}
.price .store .st{margin-left:auto;color:#111}.price .store em{font-style:normal;color:#f5a623}
.price .ttl{padding:5px 14px 0;font-size:14.5px;line-height:1.38;letter-spacing:-.4px}
.price .pr{display:flex;align-items:baseline;gap:6px;padding:6px 14px 0}
.price .pct{font-size:22px;font-weight:900;color:#e52d27}.price .now{font-size:22px;font-weight:900;letter-spacing:-.5px}
.price .pr s{font-size:12px;color:#aaa}
.price .calc{margin:8px 14px 0;padding:8px 11px;border:1px solid #ececec;border-radius:9px;font-size:12.5px}
.price .rw{display:flex;justify-content:space-between;padding:3px 0;color:#555}
.price .rw.red{color:#e52d27;font-weight:700}
.price .fin{display:flex;justify-content:space-between;align-items:center;margin-top:5px;padding-top:7px;border-top:1px dashed #ddd;font-weight:800;font-size:13.5px}
.price .fin small{font-weight:500;font-size:10.5px;color:#888;margin-left:3px}
.price .fin b{position:relative;display:inline-block;width:132px;height:34px;font-size:24px;font-weight:900;color:#1a3fd6;letter-spacing:-.5px}
.price .fv{position:absolute;right:6px;top:0;opacity:0}
.price .box{position:absolute;inset:-3px -2px;border:2.5px solid #1a3fd6;border-radius:5px;transform-origin:left center}
.price .cpn{display:flex;align-items:center;gap:8px;margin:8px 58px 0 14px;padding:8px 10px;border-radius:9px;background:#fff4ec;border:1px solid #ffd2b3;font-size:12px}
.price .cpn .t{font-weight:800;color:#e8590c}
.price .tms{position:relative;margin-left:auto;width:58px;height:17px;font-weight:800;color:#e52d27;font-variant-numeric:tabular-nums}
.price .tmv{position:absolute;right:0;top:0;opacity:0}
.price .cbtn{padding:4px 9px;border-radius:6px;background:#e8590c;color:#fff;font-weight:800;font-size:11px}
.price .chips{display:flex;gap:5px;flex-wrap:wrap;padding:8px 14px 0}
.price .chips span{padding:2px 7px;border-radius:4px;background:#f3f4f6;font-size:10.5px;color:#444}
.price .chips span.g{background:#e9f9f0;color:#0a8f4a;font-weight:700}
.price .dlv{padding:7px 14px 0;font-size:11px;color:#666}
.price .fab{position:absolute;right:12px;width:36px;height:36px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#555;z-index:6}
.price .pbar{position:absolute;left:0;right:0;bottom:0;height:56px;display:flex;gap:7px;align-items:center;padding:0 10px;background:#fff;border-top:1px solid #eee;z-index:6}
.price .pbar .h{width:40px;text-align:center;font-size:16px;color:#888;line-height:1.1}.price .pbar .h small{display:block;font-size:9px}
.price .pbar .cart{flex:1;height:40px;border-radius:7px;border:1px solid #03c75a;color:#03a94d;font-weight:800;font-size:13.5px;display:flex;align-items:center;justify-content:center}
.price .pbar .buy{flex:1.4;height:40px;border-radius:7px;background:#03c75a;color:#fff;font-weight:800;font-size:13.5px;display:flex;align-items:center;justify-content:center}
/* 문서 */
.doc .dhead{height:44px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #eee;font-size:13px;color:#e9711c;font-weight:800}
.doc .dhead .src{flex:1}
.doc .page{padding:12px 16px}
.doc .kind{font-size:11px;color:#777}
.doc h1{font-size:17px;line-height:1.35;margin:4px 0 6px;font-weight:700;letter-spacing:-.2px}
.doc .meta{font-size:11px;color:#2a6db0;line-height:1.5;margin-bottom:10px}
.doc .abs{font-size:13px;font-weight:800;margin-bottom:5px}
.doc .page p{font-size:12px;line-height:1.6;color:#333;margin-bottom:4px}
.doc .hlt{background:#f6f6f6;border-radius:6px;padding:7px 10px;margin-bottom:8px}
.doc .hlt b{font-size:12px}
.doc .hlt p{font-size:11.5px;line-height:1.5;margin:2px 0 0;color:#333}
.doc .fig{margin-top:8px;border:1px solid #e5e5e5;border-radius:6px;padding:8px}
.doc .bars{display:flex;align-items:flex-end;gap:14px;height:80px;padding:0 20px;border-bottom:1px solid #ccc}
.doc .bars i{flex:1;background:#7aa6d6}
.doc .bars i:nth-child(odd){background:#c9c9c9}
.doc .fig small{display:block;font-size:10px;color:#666;margin-top:5px}
.doc .zpop{position:absolute;left:18px;right:18px;top:220px;padding:16px;background:#fff;border-radius:10px;font-size:18px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;z-index:8}
.doc .mk{font-weight:800;padding:0 3px;background:linear-gradient(#ffe066,#ffe066) no-repeat 0 85%/0% 100%;outline:3px solid #ff8a1e;border-radius:4px}
/* 작용 원리 */
.mech{background:#000}
.mp{position:absolute;left:0;top:0;width:360px;height:318px;transform:scale(3);transform-origin:0 0;overflow:hidden;font-family:ScreenFont,sans-serif}
.mp .bg{position:absolute;left:0;top:0;width:360px;height:318px;object-fit:cover;object-position:50% 40%}
.mp .veil{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%,transparent 30%,rgba(0,40,30,.35))}
.mp .p{position:absolute;width:7px;height:7px;border-radius:50%;background:#aaffe8;box-shadow:0 0 6px 2px rgba(120,255,220,.9)}
.mp .ring{position:absolute;border-radius:50%;border:2px solid rgba(170,255,232,.9);opacity:0}
.mp .chip{position:absolute;left:10px;padding:5px 10px;border-radius:14px;background:rgba(10,30,26,.78);border:1.5px solid #7ff0d0;color:#fff;font-size:12.5px;font-weight:800;white-space:nowrap;opacity:0}
.mp .chip i{font-style:normal;display:inline-block;width:17px;height:17px;border-radius:50%;background:#7ff0d0;color:#063;font-size:11px;text-align:center;line-height:17px;margin-right:5px}
.mp .c1{top:40px}.mp .c2{top:150px}
.mp .cnt{position:absolute;right:12px;top:40px;text-align:right;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.7);opacity:0}
.mp .cnt small{display:block;font-size:10.5px;font-weight:700}
.mp .cnt b{position:relative;display:inline-block;width:150px;height:32px;font-size:26px;font-weight:900;color:#aaffe8}
.mp .cnt .v{position:absolute;right:46px;top:0;opacity:0}
.mp .cnt .u{position:absolute;right:0;top:6px;font-size:17px}
.mp .res{position:absolute;right:10px;bottom:30px;padding:6px 12px;border-radius:16px;background:#ff8a1e;color:#fff;font-size:13.5px;font-weight:900;box-shadow:0 3px 10px rgba(0,0,0,.4);opacity:0}
`;

// HyperFrames 컴포지션 한 장(컷 하나). 크기는 항상 1080x1920 이고, 다른 프로파일은 조립이 ffmpeg 로 맞춘다.
// assets/ 에 gsap.min.js·screen-medium.ttf·screen-bold.ttf·(이미지)가 있어야 한다(server/render/hf-render.ts renderScreenClip).
export const SCREEN_COMPOSITION_ID = "screen";
export function screenCompositionHtml(input: {
  readonly body: (js: string[]) => string;
  readonly durationSec: number;
  readonly fps: number;
}): string {
  const js: string[] = [];
  const body = input.body(js);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=1080, height=1920"><script src="assets/gsap.min.js"></script><style>${baseCss}${SCREEN_CSS}</style></head><body><div id="root" data-composition-id="${SCREEN_COMPOSITION_ID}" data-start="0" data-width="1080" data-height="1920" data-duration="${num(input.durationSec)}" data-fps="${input.fps}">${body}</div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});
${js.join("\n")}
window.__timelines["${SCREEN_COMPOSITION_ID}"]=tl;</script></body></html>`;
}
export function phoneScreenHtml(
  screen: CutScreen,
  image: string,
  durationSec: number,
  fps: number,
): string {
  const template = screenTemplate(screen, image);
  return screenCompositionHtml({
    durationSec,
    fps,
    body: (js) => renderScreen(template, "scr", 0, durationSec, js, 1),
  });
}
export function mechanismHtml(
  mechanism: CutMechanism,
  background: string,
  durationSec: number,
  fps: number,
): string {
  const data = mechanismTemplate(mechanism, background);
  return screenCompositionHtml({
    durationSec,
    fps,
    body: (js) => renderMechanism("mech", 0, durationSec, data, js, 1),
  });
}
