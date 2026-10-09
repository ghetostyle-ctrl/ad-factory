import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import type { LabelLayout } from "./hf-label-layout";
import type { RenderProfile } from "./theme";

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeLabel = (text: string) => text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
export function hfLabelHtml(
  labels: readonly LabelLayout[],
  duration: number,
  profile: RenderProfile,
): string {
  const s = AD_EDIT_STYLE.label;
  const data = JSON.stringify(labels).replace(/</g, String.fromCharCode(92) + "u003c");
  const markup = labels
    .map(
      (item, i) =>
        `<svg id="leader-${i}" class="leader" viewBox="0 0 1080 1920" aria-hidden="true" data-layout-ignore><path id="white-${i}" class="white"/><path id="olive-${i}" class="olive"/><circle id="anchor-${i}" class="anchor" r="${s.anchorRadiusPx}"/></svg><div id="label-${i}" class="label${item.supporting ? " supporting" : ""}" style="left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;font-size:${item.size}px"><div id="plate-${i}" class="plate"></div><div id="text-${i}" class="text">${item.lines.map((line) => `<span class="row">${escapeLabel(line)}</span>`).join("")}</div></div>`,
    )
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><style>
@font-face{font-family:LabelFont;src:url('assets/label-bold.ttf') format('truetype');font-weight:700;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#eee8db}#main{position:relative;width:100%;height:100%}.stage{position:absolute;width:1080px;height:1920px;transform:scale(${profile.width / 1080},${profile.height / 1920});transform-origin:0 0}video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.leader{position:absolute;inset:0;width:1080px;height:1920px;pointer-events:none}.leader path{fill:none;stroke-linecap:round;stroke-linejoin:round}.white{stroke:${s.white};stroke-width:${s.linePx + 2 * s.lineBorderPx}}.olive{stroke:${s.olive};stroke-width:${s.linePx}}.anchor{fill:${s.gold};stroke:${s.white};stroke-width:${s.anchorBorderPx}}
.label{position:absolute;font-family:LabelFont,sans-serif;font-weight:700;color:${s.white};font-variant-numeric:tabular-nums;letter-spacing:${s.letterSpacingEm}em}.plate{position:absolute;inset:0;background:${s.olive};border-radius:999px;box-shadow:0 5px 14px rgba(46,54,27,.08);transform-origin:50% 0}.text{position:relative;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 ${s.horizontalPaddingEm}em;line-height:1.12;text-align:left}.row{display:block;white-space:nowrap}.supporting{color:${s.olive}}.supporting .plate{background:transparent;box-shadow:none;border-radius:0;border-bottom:${s.linePx}px solid ${s.olive}}
</style></head><body><div id="main" data-composition-id="hf-labels" data-width="${profile.width}" data-height="${profile.height}" data-duration="${duration}" data-fps="${profile.fps}"><video id="footage" class="clip" src="assets/source.mp4" muted playsinline data-start="0" data-duration="${duration}" data-track-index="0"></video><div class="stage">${markup}</div></div>
<script>const labels=${data};const tl=gsap.timeline({paused:true});
labels.forEach((item,i)=>{
 const a=item.label,p=a.anchors[0],state={x:p.x,y:p.y,draw:0};
 const paint=()=>{const x=state.x*1080,y=state.y*1920,cx=item.x+item.width/2,cy=item.y;
 const d=item.supporting ? 'M '+x+' '+y+' V '+(cy-16)+' H '+(item.x+item.width)+' V '+(cy+item.height)+' H '+item.x : 'M '+x+' '+y+' V '+cy+' H '+cx;
 for(const name of ['white','olive']){const path=document.getElementById(name+'-'+i);path.setAttribute('d',d);const len=item.supporting ? Math.abs(cy-16-y)+Math.abs(item.x+item.width-x)+item.height+16+item.width : Math.abs(cy-y)+Math.abs(cx-x);path.style.strokeDasharray=String(len);path.style.strokeDashoffset=String(len*(1-state.draw));}
 const dot=document.getElementById('anchor-'+i);dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));};paint();
 const begin=a.startSec,full=Math.max(begin+${s.growSec},a.fullSec);
 tl.fromTo('#anchor-'+i,{opacity:0},{opacity:1,duration:.12},begin);
 tl.fromTo(state,{draw:0},{draw:1,duration:.2,onUpdate:paint,ease:'power2.out'},begin);
 tl.fromTo('#plate-'+i,{scaleX:.15,scaleY:.15,opacity:0},{scaleX:1,scaleY:1,opacity:1,duration:${s.growSec},ease:'power3.out'},full-${s.growSec});
 tl.fromTo('#text-'+i,{opacity:0},{opacity:1,duration:.24,ease:'power2.out'},full-.24);
 for(let k=0;k<a.anchors.length-1;k++){const from=a.anchors[k],to=a.anchors[k+1];tl.fromTo(state,{x:from.x,y:from.y},{x:to.x,y:to.y,duration:to.atSec-from.atSec,ease:'none',immediateRender:false,onUpdate:paint},from.atSec);}
 tl.to(['#label-'+i,'#leader-'+i],{opacity:0,duration:.12},Math.max(full,a.endSec-.12));
});window.__timelines['hf-labels']=tl;</script></body></html>`;
}
