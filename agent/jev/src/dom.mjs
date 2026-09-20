import { normalize } from './config.mjs';

// Executed inside the merchant page; reads rendered DOM only, no application state.
export function readShoppingDom(body) {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '').trim();
  const selector = 'a,button,input,textarea,[role="button"],[role="option"],[role="tab"]';
  const rowSelector = '[class*="ItemTile_itemTile"],[class*="ItemRow_itemRow__"],[data-testid="product-card"],[data-testid="cart-item"]';
  const product = row => (row?.querySelector('img[alt]')?.getAttribute('alt') || row?.querySelector('p')?.innerText || '').trim();
  const activeDialog = [...body.querySelectorAll('[role="dialog"],dialog')].filter(visible).at(-1);
  const controls = [...body.querySelectorAll(selector)].flatMap((el, index) => {
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.type === 'hidden'
      || el.closest('footer') || (activeDialog && !activeDialog.contains(el))) return [];
    const row = el.closest(rowSelector);
    return [{ index, tag: el.tagName.toLowerCase(), label: label(el).slice(0, 300),
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
      href: el.getAttribute('href') || '', type: el.type || '', value: el.value || '',
      product: product(row), context: (row?.innerText || '').slice(0, 800) }];
  });
  const rows = [...body.querySelectorAll(rowSelector)].filter(row => visible(row)
    && [...row.querySelectorAll('button')].some(button => /^(?:Remove item|Usuń produkt|Decrease quantity|Zmniejsz ilość)$/i.test(label(button))));
  const cart = rows.filter(row => !rows.some(other => other !== row && other.contains(row))).map(row => ({
    name: product(row), qty: Number(row.querySelector('[role="status"]')?.innerText.trim()),
  }));
  // Public text is used locally for independent validation, never sent wholesale to Jev.
  const text = body.innerText;
  const headings = [...body.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(el => el.innerText.trim());
  return { text, controls, cart, headings };
}

export function parseObservation(raw, url, config) {
  const text = raw.text.replace(/\u00a0/g, ' ');
  const total = text.match(/(?:^|\n)(?:ŁĄCZNIE|TOTAL)\s*\n\s*([\d ]+[,.]\d{2})\s*(?:zł|PLN)/i)?.[1];
  const checkoutLine = text.match(/(?:^|\n)\s*(\d+)\s+(?:prod\. z:|items? from:)\s*([^\n]+)/i);
  const stripped = normalize(text).replace(/[,]/g, '');
  const address = normalize(config.expectedAddress).replace(/[,]/g, '');
  const checkoutReady = raw.headings.some(h => /^(?:Podsumowanie zamówienia|Order summary)$/i.test(h))
    && raw.controls.some(c => /^(?:Zamów i zapłać|Order and pay)$/i.test(c.label));
  const cartHeading = raw.headings.some(h => /^(?:Twoje zamówienie|Your order)$/i.test(h));
  const empty = /(?:koszyk jest pusty|koszyk.*pusty|nic tu jeszcze nie ma|Gdy dodasz produkty z oferty punktu, pojawią się one w tym miejscu\.|your (?:basket|cart) is empty|empty (?:basket|cart))/i.test(text);
  const count = text.match(/(?:^|\n)\s*(\d+)\s+(?:produkt(?:y|ów)?|items?)\s*(?:\n|$)/i);
  const cartUnits = count ? Number(count[1]) : empty ? 0 : null;
  return { url, controls: raw.controls, cart: raw.cart,
    cartKnown: cartHeading && cartUnits !== null && raw.cart.every(r => r.name && Number.isInteger(r.qty) && r.qty > 0)
      && cartUnits === raw.cart.reduce((n, row) => n + row.qty, 0),
    cartUnits, destinationVerified: (` ${stripped} `).includes(` ${address} `), checkoutReady,
    checkoutUnits: checkoutLine ? Number(checkoutLine[1]) : null,
    checkoutMerchant: checkoutLine?.[2]?.trim() || '',
    totalMinor: total ? Math.round(Number(total.replace(/ /g, '').replace(',', '.')) * 100) : null,
    blocked: /(?:verify you are human|potwierdź, że jesteś człowiekiem|captcha challenge)/i.test(text),
    unavailable: /(?:^|\n)(?:W tej chwili lokal jest zamknięty\.|Tymczasowo zamknięte|Punkt .+ jest tymczasowo zamknięty|Temporarily closed|[^\n]{1,120} teraz nie pracuje\.)(?:\n|$|\s)/i.test(text),
  };
}
