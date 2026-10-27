/** Export static 1080-square flashcards and a contact sheet; no video or timeline is rendered. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const folder=dirname(fileURLToPath(import.meta.url));
const output=join(folder,"stills"); await mkdir(output,{recursive:true});
const origin=process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:8000/";
const base=new URL("release-video/flashcards/",origin);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE});
try {
  const page=await browser.newPage({viewport:{width:1080,height:1080},deviceScaleFactor:1});
  const errors=[]; page.on("pageerror",(error)=>errors.push(error.message));
  await page.goto(base.href); await page.evaluate(()=>window.ready);
  const cards=await page.evaluate(()=>window.storyboardCards);
  const details=await page.evaluate(()=>window.storyboardDetails);
  const frames=[...cards.map((card)=>({id:card.id,name:card.name,file:`card-${card.id}.png`,query:`card=${card.id}`})),...details.map((detail)=>({id:`${detail.card}-${detail.beat}`,name:detail.name,file:detail.file,query:`card=${detail.card}&beat=${detail.beat}`}))];
  for (const card of frames) {
    await page.goto(new URL(`?${card.query}&export=1`,base).href);
    await page.evaluate(()=>window.ready);
    const bounds=await page.evaluate(()=>[...document.querySelectorAll(".artboard h2,.artboard .dek,.artboard .source,.artboard .label,.artboard .cell-explanation,.artboard .limit-copy,.artboard .edge-sentence>*,.artboard .primitive-callout p,.artboard .hook-benefits,.artboard .fps-hero,.artboard td,.artboard th,.artboard .error-label,.artboard .error-legend p")].map((node)=>{
      const b=node.getBoundingClientRect();
      return {text:node.textContent,class:node.className,top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,scrollWidth:node.scrollWidth};
    }));
    for (const b of bounds) if (b.left<0 || b.right>1081 || b.bottom>1010 || b.scrollWidth>b.width+1) throw new Error(`Card ${card.id} text overflow: ${JSON.stringify(b)}`);
    await page.locator(".artboard").screenshot({path:join(output,card.file),animations:"disabled"});
    process.stdout.write(`Saved card ${card.id}: ${card.name}\n`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  await page.setViewportSize({width:1200,height:900});
  const thumb=(card)=>`<figure><img src="${new URL(`stills/${card.file}`,base).href}"><figcaption>${card.id}. ${card.name}</figcaption></figure>`;
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:30px;background:#eeeae2;color:#28251f;font:16px Arial}h1{margin:0 0 12px;font-size:28px}h2{margin-top:28px}p{margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}figure{margin:0}img{width:100%;display:block}figcaption{font-size:14px;padding:10px 2px;line-height:1.3;min-height:56px}</style><h1>Honeycomb-Surfels · release flashcards</h1><p>Static storyboard · words, examples and sequence for review</p><div class="grid">${frames.slice(0,cards.length).map(thumb).join("")}</div><h2>Additional keyframes</h2><div class="grid">${frames.slice(cards.length).map(thumb).join("")}</div>`);
  await page.evaluate(()=>Promise.all([...document.images].map((img)=>img.decode())));
  await page.screenshot({path:join(folder,"contact-sheet.png"),fullPage:true});
  process.stdout.write(`Saved static cards and ${join(folder,"contact-sheet.png")}\n`);
} finally {await browser.close();}
