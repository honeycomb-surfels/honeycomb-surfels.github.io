/** Animate the reviewed cards with genuine research media and a deterministic export timeline. */
import { createSurfaceStage } from "./surface-stage.js";

const $=(selector,root=document)=>root.querySelector(selector);
const clamp=(x,low=0,high=1)=>Math.max(low,Math.min(high,x));
const ease=x=>{x=clamp(x);return x*x*(3-2*x);};
const opacity=(node,value)=>{if(node)node.style.opacity=clamp(value);};
const duration=43, transition=.24;
const shots=[
  {id:"01",start:0,end:4.8}, {id:"02",start:4.8,end:8.6},
  {id:"03",start:8.6,end:12.3}, {id:"04",start:12.3,end:16.1},
  {id:"05",start:16.1,end:20.2}, {id:"06",start:20.2,end:24},
  {id:"07",start:24,end:27.6}, {id:"08",start:27.6,end:31.2},
  {id:"09",start:31.2,end:34.8}, {id:"10",start:34.8,end:38.9},
  {id:"11",start:38.9,end:duration},
];
window.videoConfig={duration,output:"release",coverTime:10.4};
if(new URLSearchParams(location.search).has("render"))document.body.classList.add("render");
const scene=$("#scene"), cards=new Map(), clips=new Map(), flight=[];
let mesh,time=0,playing=false,origin=0,pendingSeek=null;

async function loadCardDocument(query="") {
  const frame=document.createElement("iframe"); frame.className="source-frame"; frame.tabIndex=-1; frame.setAttribute("aria-hidden","true");
  const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=()=>reject(new Error("Card source could not load"));});
  frame.src=`flashcards/index.html?export=1${query}`; document.body.append(frame);
  await loaded; await frame.contentWindow.ready; return frame;
}

/** Clone the approved layout, resolving media URLs and isolating SVG references across source documents. */
function copyCard(original,key) {
  const card=document.importNode(original,true);
  const originals=[...original.querySelectorAll("img")];
  [...card.querySelectorAll("img")].forEach((img,i)=>{img.src=originals[i].src;});
  for(const svg of card.querySelectorAll("svg")) {
    const ids=new Map();
    for(const node of svg.querySelectorAll("[id]")){const old=node.id;node.id=`film-${key}-${old}`;ids.set(old,node.id);}
    for(const node of svg.querySelectorAll("[fill],[clip-path]"))for(const attr of ["fill","clip-path"]){
      const value=node.getAttribute(attr),match=value?.match(/^url\(#(.+)\)$/);
      if(match&&ids.has(match[1]))node.setAttribute(attr,`url(#${ids.get(match[1])})`);
    }
  }
  card.classList.add("film-card"); card.style.opacity="0"; card.style.visibility="hidden";
  scene.append(card); return card;
}

/** Fully loaded blob media stay seekable even on a simple server without HTTP byte ranges. */
const clipBlobs=new Map();
async function addClip(key,source,img,container) {
  if(!clipBlobs.has(source))clipBlobs.set(source,fetch(source).then(async response=>{
    if(!response.ok)throw new Error(`Missing research media: ${source}; run npm run assets.`);
    return URL.createObjectURL(await response.blob());
  }));
  const video=document.createElement("video"); video.muted=true;video.playsInline=true;video.preload="auto";video.setAttribute("aria-label",img?.alt??key);
  if(img){video.style.cssText=img.style.cssText;video.className=img.className;img.replaceWith(video);}else container.append(video);
  const loaded=new Promise((resolve,reject)=>{video.addEventListener("loadeddata",resolve,{once:true});video.addEventListener("error",()=>reject(new Error(`Could not decode ${source}`)),{once:true});});
  video.src=await clipBlobs.get(source);video.load();await loaded;video.pause();clips.set(key,video);
}

function seek(video,seconds) {
  const target=clamp(seconds,0,video.duration-.05);
  if(!video.seeking&&video.readyState>=2&&Math.abs(video.currentTime-target)<.008)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const clean=()=>{video.removeEventListener("seeked",done);video.removeEventListener("error",failed);};
    const done=()=>{clean();Math.abs(video.currentTime-target)<.01?resolve():reject(new Error(`Seek did not reach ${target} in ${video.getAttribute("aria-label")}`));};
    const failed=()=>{clean();reject(new Error("Research-video seek failed"));};
    video.addEventListener("seeked",done,{once:true});video.addEventListener("error",failed,{once:true});video.currentTime=target;
  });
}

function curve(points,t) {
  const u=1-t;
  return [0,1].map(i=>u*u*u*points[0][i]+3*u*u*t*points[1][i]+3*u*t*t*points[2][i]+t*t*t*points[3][i]);
}

function flightPose(t,index) {
  const start=index?.33:0,land=index?1.95:1.7;
  const end=index?[466.2,320.4]:[601.4,224.2];
  if(t>=land)return end;
  const p=ease((t-start)/(land-start));
  return curve(index?[[980,720],[690,920],[260,480],end]:[[180,480],[420,50],[900,400],end],p);
}

function renderOpening(t) {
  const first=cards.get("01"),visible=t<4.8;
  opacity($("h2",first),ease((t-1.45)/.4));
  opacity($(".dek",first),ease((t-1.95)/.4));
  opacity($(".intro-hexels",first),ease((t-2.35)/.35));
  for(const node of first.querySelectorAll(".topline,.footer"))opacity(node,ease((t-2.35)/.35));
  const hero=$(".hero-logo",first);
  for(const node of hero.querySelectorAll(".hxl-bee"))opacity(node,0);
  for(const cell of hero.querySelectorAll(".hxl-cell")) {
    const index=["top","left","right"].indexOf(cell.dataset.cell);
    const appear=ease((t-1.45-index*.06)/.3);
    const contact=cell.dataset.cell==="top"?1.7:cell.dataset.cell==="left"?1.95:2.18;
    const pulse=cell.dataset.cell==="right"?0:Math.exp(-(((t-contact)/.19)**2));
    const b=cell.getBBox(),x=b.x+b.width/2,y=b.y+b.height/2;
    const transform=`translate(${x} ${y}) scale(${.72+.28*appear+.09*pulse}) translate(${-x} ${-y})`;
    cell.setAttribute("transform",transform);opacity(cell,appear);
    const glint=hero.querySelector(`.cell-glint[data-cell="${cell.dataset.cell}"]`);
    glint.setAttribute("transform",transform);opacity(glint,.65*pulse*appear);
  }
  flight.forEach((node,i)=>{
    const p=flightPose(t,i),next=flightPose(t+.008,i),land=i?1.95:1.7;
    const dx=next[0]-p[0],dy=next[1]-p[1];
    const face=t>=land?(i?-1:1):(dx>0?-1:1);
    const settle=ease((t-(land-.18))/.18);
    const bank=(1-settle)*clamp(-face*dy*8,-18,18)+settle*(i?-10:40);
    const size=(i?122:152)+(i?7:5)*ease((t-1.25)/.7);
    node.style.width=`${size}px`;node.style.height=`${size}px`;node.style.transform=`translate(${p[0]}px,${p[1]}px) translate(-50%,-50%)`;
    opacity(node,visible?(i?ease((t-.33)/.12):1)*(1-ease((t-(4.8-transition))/transition)):0);
    $(".hxl-bee",node).setAttribute("transform",`rotate(${bank}) scale(${face} 1)`);
    const flap=1-(1-ease((t-land)/.3))*(.35-.35*Math.cos(t*Math.PI/.045+i));
    $(".hxl-wings",node).setAttribute("transform",`translate(.47 -4.66) scale(1 ${flap}) translate(-.47 4.66)`);
  });
}

/** Present one exact timeline time; every source clip is paused and explicitly sought. */
window.renderAt=async seconds=>{
  time=clamp(seconds,0,duration);
  const active=[];
  for(const shot of shots) {
    const incoming=shot.start>0&&time>=shot.start-transition&&time<shot.start;
    const current=time>=shot.start&&time<shot.end||(shot.id==="11"&&time===duration);
    const alpha=current?1:incoming?ease((time-(shot.start-transition))/transition):0;
    const card=cards.get(shot.id);opacity(card,alpha);card.style.visibility=alpha>0?"visible":"hidden";
    if(current||incoming)active.push({...shot,local:Math.max(0,time-shot.start),alpha});
  }
  renderOpening(time);
  const waits=[];
  for(const shot of active) {
    const card=cards.get(shot.id),u=shot.local;
    if(shot.id==="02") {
      opacity($(".edge-lead",card),ease((u-.15)/.25));opacity($(".edge-scene",card),ease((u-.35)/.25));opacity($(".edge-location",card),ease((u-.65)/.3));
      const pop=ease((u-.95)/.16),callout=$(".primitive-callout",card);
      opacity(callout,pop*(1-ease((u-3.15)/.22)));
      callout.style.transform=`translateY(${8*(1-pop)}px) scale(${.94+.06*pop})`;
      waits.push(seek(clips.get("intro-scene"),.6+u*.55));
    }
    if(shot.id==="04")waits.push(seek(clips.get("native-scene"),.6+u*.55));
    if(shot.id==="05") [...card.querySelectorAll(".limit-row")].forEach((row,i)=>opacity(row,.25+.75*ease((u-i*.42)/.3)));
    if(shot.id==="06")waits.push(seek(clips.get("garden"),.8+u*.7));
    if(shot.id==="08") {
      const tiled=ease((u-1.95)/.3);opacity($(".anatomy-crop",card),1-tiled);opacity($(".primitive-points",card),1-tiled);opacity($(".structure-demo",card),tiled);
      waits.push(seek(clips.get("anatomy"),6+u*.5));waits.push(seek(clips.get("structure"),.5+Math.max(0,u-1.7)*1.15));
    }
    if(shot.id==="09")mesh.render(u);
    if(shot.id==="10")[...card.querySelectorAll(".cell-grid>div")].forEach((node,i)=>opacity(node,.25+.75*ease((u-i*.32)/.3)));
    if(shot.id==="11") {
      waits.push(seek(clips.get("closing-scene"),.6+Math.min(u,3)*.55));
      opacity($(".cta",card),ease((u-.4)/.3));
      [...card.querySelectorAll(".cell-glint")].forEach((glint,i)=>opacity(glint,glint.dataset.cell==="right"?0:.55*Math.exp(-(((u-1.1-i*.08)/.2)**2))));
    }
  }
  await Promise.all(waits);
  if(waits.length||active.some(shot=>shot.id==="09"))await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  $("#scrub").value=time;$("#time").textContent=`${time.toFixed(1)} / ${duration.toFixed(1)} s`;
};

window.ready=(async()=>{
  const mainFrame=await loadCardDocument();
  for(const original of mainFrame.contentDocument.querySelectorAll(".artboard")) {
    const id=original.dataset.card,card=copyCard(original,id);card.style.zIndex=Number(id)*10;cards.set(id,card);
  }
  const source=$(".hero-logo svg",cards.get("01"));
  for(let i=0;i<2;i++){
    const node=document.createElement("div");node.className="flight-bee";
    const svg=source.cloneNode(true);svg.setAttribute("viewBox","-24 -24 48 48");svg.querySelector(".hxl-cells").remove();svg.querySelector(".hxl-lap").remove();svg.querySelector(".second-bee").remove();
    for(const element of svg.querySelectorAll("[id]"))element.id=`flight-${i}-${element.id}`;
    for(const element of svg.querySelectorAll("[clip-path]"))element.setAttribute("clip-path",element.getAttribute("clip-path").replace("url(#",`url(#flight-${i}-`));
    node.append(svg);scene.append(node);flight.push(node);
  }
  const card8=cards.get("08"),structure=document.createElement("div");structure.className="structure-demo";card8.append(structure);
  const geometry=cards.get("09"),stage=document.createElement("div");stage.className="mesh-stage";$(".geo-grid>div",geometry).append(stage);$(".geo-grid>div>img",geometry).style.visibility="hidden";$(".geo-grid p",geometry).textContent="Surface";
  await Promise.all([
    addClip("intro-scene","assets/kitchen-ours.mp4",$(".phone img",cards.get("02"))),
    addClip("native-scene","assets/kitchen-ours.mp4",$(".speed-scene img",cards.get("04"))),
    addClip("closing-scene","assets/kitchen-ours.mp4",$(".device-pair .phone:last-child img",cards.get("11"))),
    addClip("garden","assets/garden-ours.mp4",$(".garden img",cards.get("06"))),
    addClip("anatomy","../static/anim/hexel_anatomy.mp4",$(".anatomy-crop img",card8)),
    addClip("structure","../static/anim/hexels_on_surface.mp4",null,structure),
    createSurfaceStage(stage,{width:303,height:330}).then(result=>{mesh=result;}),
    ...[...scene.querySelectorAll("img")].map(img=>img.decode().catch(()=>{throw new Error(`Could not decode storyboard image: ${img.src}`);})),document.fonts.ready,
  ]);
  mainFrame.remove();
  const resize=()=>{scene.style.transform=`scale(${$("#viewport").clientWidth/1080})`;};
  new ResizeObserver(resize).observe($("#viewport"));resize();await window.renderAt(0);
  $("#play").disabled=false;$("#scrub").disabled=false;
  $("#status").textContent="Release video · 43 seconds · 1080 square · muted. Play or scrub the edit.";
  $("#play").addEventListener("click",()=>{
    if(time>=duration){pendingSeek=0;time=0;}
    playing=!playing;origin=performance.now()-time*1000;$("#play").textContent=playing?"Pause":"Play";
  });
  $("#scrub").addEventListener("input",event=>{playing=false;$("#play").textContent="Play";pendingSeek=Number(event.target.value);});
  async function frame(){
    if(pendingSeek!==null){const target=pendingSeek;pendingSeek=null;await window.renderAt(target);origin=performance.now()-time*1000;}
    else if(playing){await window.renderAt((performance.now()-origin)/1000);if(time>=duration){playing=false;$("#play").textContent="Replay";}}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
window.ready.catch(error=>{$("#status").textContent=error.message;});
