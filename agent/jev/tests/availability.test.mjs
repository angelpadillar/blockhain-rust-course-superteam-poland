import test from 'node:test';
import assert from 'node:assert/strict';
import {parseObservation} from '../src/dom.mjs';
const config={expectedAddress:'Test Street 20'};
const parse=text=>parseObservation({text,cart:[],controls:[],headings:[]},'https://glovoapp.com/pl/pl/krakow/stores/test',config);
test('closed-store modal observed on 17 September is unavailable despite an empty basket behind it',()=>{
 const raw={text:'Test Street 20\nDuży Ben teraz nie pracuje. Następne otwarcie: piątek\nSprawdź otwarte lokale\nZaplanuj zamówienie\nGdy dodasz produkty z oferty punktu, pojawią się one w tym miejscu.',
  cart:[],controls:[],headings:['Duży Ben','Twoje zamówienie']};
 const obs=parseObservation(raw,'https://glovoapp.com/pl/pl/krakow/stores/test',config);
 assert.equal(obs.cartKnown,true);assert.equal(obs.unavailable,true);
});
test('same notice works with a separate next-opening line, NBSP, mixed case and another merchant',()=>{
 for(const text of ['Duży Ben teraz nie pracuje.\nNastępne otwarcie: piątek','Duży Ben\u00a0teraz nie pracuje. Następne otwarcie: piątek','Inny lokal TERAZ NIE PRACUJE.'])assert.equal(parse(text).unavailable,true);
});
test('existing closed states remain recognized',()=>{
 for(const text of ['W tej chwili lokal jest zamknięty.','Tymczasowo zamknięte','Punkt Duży Ben jest tymczasowo zamknięty','Temporarily closed'])assert.equal(parse(text).unavailable,true);
});
test('opening information, FAQ questions and open-store text do not falsely mark unavailable',()=>{
 for(const text of ['Duży Ben\nOtwarte\nCzas dostawy 20 minut','Kiedy Duży Ben teraz nie pracuje?','Godziny otwarcia\nNastępne otwarcie: piątek','Jak zamówić dostawę z Duży Ben?'])assert.equal(parse(text).unavailable,false);
});
