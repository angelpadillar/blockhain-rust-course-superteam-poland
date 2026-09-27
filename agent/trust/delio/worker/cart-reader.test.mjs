import test from 'node:test';
import assert from 'node:assert/strict';
import { cartLines, plnMinor, couponObservation, productPaths, summaryRows } from './cart-reader.mjs';

const line = (id, qty) => `<div data-testid="cart-line-${id}"><a href="/products/${id}-maslo-polskie"><h3>Masło</h3></a><span class="qty">${qty} szt.</span></div>`;

test('cartLines extracts id and explicit szt quantity only', () => {
  const html = `${line('A0000953', 2)}${line('A0000926', 1)}`;
  const { lines, unparsedLines } = cartLines(html);
  assert.equal(unparsedLines, 0);
  assert.deepEqual(lines, [{ productId: 'A0000953', quantity: 2 }, { productId: 'A0000926', quantity: 1 }]);
});

test('cartLines ignores anchors inside product-tile promo cards', () => {
  const tile = `<div data-testid="product-tile-A0007251-herbata"><a href="/products/A0007251-herbata"><h3>Herbata</h3></a><button>Dodaj do koszyka</button></div>`;
  const { lines, unparsedLines } = cartLines(tile + line('A0000953', 3));
  assert.equal(unparsedLines, 0);
  assert.deepEqual(lines, [{ productId: 'A0000953', quantity: 3 }]);
});

test('cartLines reports a gap rather than guessing a quantity', () => {
  const html = `<a href="/products/A0000953-maslo"><h3>Masło</h3></a><div>no quantity here</div>`;
  const { lines, unparsedLines } = cartLines(html);
  assert.equal(lines.length, 0);
  assert.equal(unparsedLines, 1);
});

test('cartLines accepts quantity input values', () => {
  const html = `<a href="/products/A0000953-maslo">x</a><input aria-label="Ilość produktu" value="4">`;
  assert.deepEqual(cartLines(html).lines, [{ productId: 'A0000953', quantity: 4 }]);
});

test('plnMinor parses Polish price text and rejects non-prices', () => {
  assert.equal(plnMinor('4,29 zł'), 429);
  assert.equal(plnMinor('1 234,56 zł'), 123456);
  assert.equal(plnMinor('12.34'), null);
  assert.equal(plnMinor('zł'), null);
});

test('couponObservation only reports the configured code with nearby context', () => {
  assert.equal(couponObservation('<p>other text</p>', 'z5913').observed, false);
  const hit = couponObservation('<div>Kupon z5913 aktywowany -75,00 zł</div>', 'z5913');
  assert.equal(hit.observed, true);
  assert.equal(hit.activeHint, true);
});

test('productPaths keeps first product path per id', () => {
  const map = productPaths('<a href="/products/A0000953-maslo">a</a><a href="/products/A0000953-inna">b</a>');
  assert.equal(map.A0000953, '/products/A0000953-maslo');
});
