import { createServer } from 'node:http';
export async function fixture({ total = '10,00', address = 'Test Street 20', existing = false } = {}) {
  let orders = 0;
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Local shopping test</title></head><body><main></main><script>
    const address = ${JSON.stringify(address)};
    let quantity = Number(sessionStorage.getItem('qty') || ${existing ? '1' : '0'});
    const product = 'Test apple juice 1 L';
    const main = document.querySelector('main');
    function row(cart) { return '<article class="'+(cart ? 'ItemRow_itemRow__test':'ItemTile_itemTile_test')+'"><img alt="'+product+'"><p>'+product+'</p>'+(cart ? '<button aria-label="Remove item" onclick="quantity--;save();render()">−</button><span role="status">'+quantity+'</span>' : '')+'<button aria-label="'+(cart?'Increase quantity':'Add item')+'" onclick="quantity++;save();render()">+</button></article>'; }
    function purchase(){fetch('/orders',{method:'POST'})}
    function checkout(){location.href='/pl/pl/krakow/order-summary'}
    function save(){sessionStorage.setItem('qty', String(quantity));}
    function render() {
      if (location.pathname.includes('order-summary')) {
        main.innerHTML = '<h2>Podsumowanie zamówienia</h2><p>'+quantity+' prod. z: Test shop</p><h2>Adres dostawy</h2><p>'+address+'</p><p>ŁĄCZNIE</p><p>${total} zł</p><button onclick="purchase()">Zamów i zapłać</button>';return;
      }
      const previous = document.querySelector('input')?.value || '';
      main.innerHTML = '<h1>Test shop</h1><p>'+address+'</p><label>Search<input type="search" aria-label="Search products" oninput="search(this.value)"></label><section id="results"></section><h2>Twoje zamówienie</h2><p>'+(quantity ? quantity+' produkty' : 'Twój koszyk jest pusty')+'</p>'+(quantity?row(true):'')+'<button onclick="checkout()">Przejdź do kasy</button>';
      document.querySelector('input').value = previous;search(previous);
    }
    function search(value){document.querySelector('#results').innerHTML = value.length>2 ? row(false) : '';}
    render();
  </script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url === '/orders') { orders++; res.end('unexpected-order'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/pl/pl/krakow/stores/test-shop`,
    orders: () => orders, close: () => new Promise(resolve => server.close(resolve)) };
}
