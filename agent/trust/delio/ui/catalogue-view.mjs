export function normalizeSearchText(value) {
  return String(value ?? '').toLocaleLowerCase('pl').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').trim();
}

export function filterCatalogueItems(items, { query = '', categoryId = '' } = {}) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const haystack = normalizeSearchText([item.title, item.name, item.packSize, item.productId].join(' '));
    return (!categoryId || item.categoryId === categoryId) && terms.every(term => haystack.includes(term));
  });
}

export function visibleRegionalOffer(product, { regionId = null, now = Date.now() } = {}) {
  const offer = product?.availability;
  if (!regionId || !offer || offer.regionId !== regionId || offer.scopeBound !== true
      || offer.source !== 'owned_merchant_observation' || !['available', 'unavailable'].includes(offer.status)
      || !Number.isSafeInteger(offer.observedAt) || offer.observedAt < 0 || offer.observedAt > now
      || !Number.isSafeInteger(offer.validUntil) || offer.validUntil <= now
      || offer.validUntil <= offer.observedAt || offer.validUntil - offer.observedAt > 120_000
      || !Number.isSafeInteger(offer.unitPriceMinor) || offer.unitPriceMinor < 0 || offer.currency !== 'PLN') return null;
  return offer;
}

// Exact observed public image route; never load a caller-supplied private host or arbitrary optimizer source.
export function productImageUrl(product) {
  try {
    const url = new URL(product?.imageUrl);
    const keys = [...url.searchParams.keys()].sort();
    if (url.origin !== 'https://delio.com.pl' || url.username || url.password || url.hash
        || url.pathname !== '/_next/image' || keys.join(',') !== 'q,url,w'
        || !['75', '80'].includes(url.searchParams.get('q')) || url.searchParams.get('w') !== '1920') return null;
    const image = new URL(url.searchParams.get('url'));
    if (image.origin !== 'https://images.prod.lait.app' || image.username || image.password || image.search || image.hash
        || !/^\/pim_prod\/product-images\/[A-Za-z0-9_-]+\.png$/.test(image.pathname)) return null;
    return url.href;
  } catch { return null; }
}
