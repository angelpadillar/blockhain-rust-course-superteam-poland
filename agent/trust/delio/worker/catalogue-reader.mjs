import { createHash } from 'node:crypto';
// Read rendered product cards only; page scripts, account fields and hidden JSON
// are never exported. Delio's observed product-tile contract is deliberately narrow.
const decode = s => String(s || '').replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi, x => {
  const named = {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};
  if(named[x])return named[x]; const n=x[2]==='x'?parseInt(x.slice(3),16):parseInt(x.slice(2),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
});
const text = s => decode(String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function productCards(html) {
  if(typeof html!=='string'||html.length>2_100_000)throw new Error('catalogue_markup_invalid');
  const clean=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const cards=[];let incomplete=0;
  for(const m of clean.matchAll(/<div\b[^>]*data-testid="product-tile-(A\d{7})-[^"]*"[^>]*>/g)) {
    let depth=1,end=null;
    const rest=clean.slice(m.index+m[0].length);
    for(const tag of rest.matchAll(/<\/?div\b[^>]*>/g)){depth+=tag[0].startsWith('</')?-1:1;if(depth===0){end=m.index+m[0].length+tag.index+tag[0].length;break;}}
    if(end===null){incomplete++;continue;}
    const card=clean.slice(m.index,end),id=m[1];
    const anchor=card.match(/<a\b[^>]*href="(\/products\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/);
    const name=anchor?.[2].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/)?.[1];
    const pack=anchor?.[2].match(/<span\b[^>]*class="sr-only"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    const image=card.match(/<img\b[^>]*\ssrc="([^"]+)"/);
    // Current price is the primary price span, not crossed-out/lowest historical price.
    const prices=[...card.matchAll(/<span\b[^>]*class="[^"]*\b(?:text-text-primary|text-primary-900)\b[^"]*"[^>]*>([^<]+)<\/span>/g)]
      .map(x=>text(x[1])).filter(s=>/^\d+(?:[ ,.]\d{3})*[,.]\d{2}\s*zł$/.test(s));
    if(!anchor||!name||!anchor[1].startsWith('/products/'+id+'-')||prices.length!==1)continue;
    const price=prices[0].replace(/\s*zł$/,'').replace(/[ .](?=\d{3})/g,'').replace(',','.');
    const unitPriceMinor=Math.round(Number(price)*100);
    if(!Number.isSafeInteger(unitPriceMinor)||unitPriceMinor<0)continue;
    let imageUrl=null;try{const u=new URL(decode(image?.[1]),'https://delio.com.pl');if(u.origin==='https://delio.com.pl'&&u.pathname==='/_next/image')imageUrl=u.href;}catch{}
    cards.push({productId:id,title:text(name).slice(0,300),packSize:text(pack||'').slice(0,80),unitPriceMinor,currency:'PLN',sourceUrl:'https://delio.com.pl'+decode(anchor[1]),imageUrl,
      cardSha256:createHash('sha256').update(card).digest('hex'),stock:'not_verified',couponEligibility:'unknown'});
  }
  const unique=new Map(),conflicts=new Set();for(const p of cards){const old=unique.get(p.productId);if(old&&old.unitPriceMinor!==p.unitPriceMinor)conflicts.add(p.productId);unique.set(p.productId,p);}
  return {items:[...unique.values()].filter(p=>!conflicts.has(p.productId)),incompleteCards:incomplete,conflictingProducts:conflicts.size,completeInventory:false};
}
export function catalogueLinks(html){
  const clean=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const found=new Map();for(const m of clean.matchAll(/<a\b[^>]*href="(\/(?:categories|collections)\/[A-Za-z0-9_/-]+)"[^>]*>([\s\S]*?)<\/a>/g)){
    const label=text(m[2]);if(label&&label.length<160)found.set(m[1],{path:m[1],label});
  }return [...found.values()].slice(0,100);
}
