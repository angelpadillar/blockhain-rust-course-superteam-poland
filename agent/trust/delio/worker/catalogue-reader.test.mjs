import test from 'node:test';
import assert from 'node:assert/strict';
import {productCards,catalogueLinks} from './catalogue-reader.mjs';
import {validateRequest} from './policy.mjs';
const card=(id='A0000953',price='4,29',regular=false)=>`<div data-testid="product-tile-${id}-maslo"><div><img src="https://delio.com.pl/_next/image?url=https%3A%2F%2Fimages.prod.lait.app%2Fpim_prod%2Fproduct-images%2Fx.png&amp;w=1920&amp;q=80"><a href="/products/${id}-maslo"><h3>Masło &amp; ser</h3><span class="sr-only">200 g</span></a><span class="${regular?'text-primary-900':'text-text-primary'} text-body-lg">${price} zł</span><span data-testid="old-price"><span class="line-through">8,99 zł</span></span></div></div>`;
test('product projection parses regular and sale prices, excludes account/script data and old prices',()=>{
 const h='<input value="PRIVATE_EMAIL"><script>'+card('A0000001')+'</script>'+card()+card('A0000002','0,34',true);
 const r=productCards(h);assert.equal(r.items.length,2);assert.deepEqual(r.items.map(x=>x.unitPriceMinor),[429,34]);assert.equal(r.items[0].title,'Masło & ser');assert.equal(r.items[0].stock,'not_verified');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_EMAIL|8,99/);
});
test('incomplete cards and conflicting same-product prices cannot become offers',()=>{
 const r=productCards(card()+card('A0000953','5,99')+card('A0000003').slice(0,-6));assert.equal(r.items.length,0);assert.equal(r.conflictingProducts,1);assert.equal(r.incompleteCards,1);assert.equal(r.completeInventory,false);
});
test('only category/collection links, never account or external destinations',()=>{
 const r=catalogueLinks('<a href="/categories/fruit">Owoce</a><a href="https://evil.test/categories/a">Bad</a><a href="/profile/account">Private</a>');assert.deepEqual(r,[{path:'/categories/fruit',label:'Owoce'}]);
 for(const path of ['https://evil.test/','/profile/account','/categories/a?x=1','/categories/../profile','//evil.test'])assert.throws(()=>validateRequest({operation:'readCatalogue',path}));
 assert.equal(validateRequest({operation:'readCatalogue',path:'/'}).operation,'readCatalogue');
 assert.throws(()=>validateRequest({operation:'readCatalogue',selector:'body'}));
});
