# V5 bounded shopping policy

This benchmark permits native shopping search, opening neutral product links, choosing product options, bounded quantities, adding an item to a guest cart, viewing that cart, and removing only items recorded as added by this run. It rejects buy-now, checkout, order placement, payment, account changes and upload controls. Polish controls such as **Dodaj do koszyka** are distinct from **Kup teraz**, **Przejdź do realizacji zamówienia** and **Złóż zamówienie**.

This is a limited, conservative HTML control and request policy. It is not proof that an arbitrary website is safe, that a label is truthful, or that an endpoint performs only the apparent operation. Unknown controls/endpoints stop that action; some supported-looking real sites will remain unsupported.

## Executor contract

`classifyAction(action, context)` returns `{allowed, category, reason}`. `validateAction` returns a shallow-frozen validated copy or throws `SafetyError`. The executor must populate action metadata from its fresh DOM snapshot, preserve actual node identity, and revalidate immediately before native dispatch. The model selects only a currently offered reference; it does not supply labels, URLs, ownership, JavaScript or selectors.

Actions contain `operation`, `kind`, `label`, and relevant observed `href`, `formAction`, `formMethod`, `inputType`, `value`, `role`, `tag`, `ref` or `cartItemKey`. Operations are `search`, `open_product`, `choose_option`, `set_quantity`, `add_to_cart`, `remove_own_cart_item`, `dismiss_cookie`, `view_cart` and `test_preference`. Native kinds are constrained per operation.

Context contains the current URL and fixed allowed origin. `guestSession: true` is required for cart writes. The executor owns `ownedCartItemKeys`, adding a key only after independently observing that this run added that guest-cart item. A product name match or model assertion is insufficient ownership evidence. Removal and cart quantity changes require a matching owned key. `quantityScope` is `product` by default or `cart`; default `maxQuantity` is 10. Choosing an otherwise unlabeled option requires executor-observed `productOptionContext: true`.

Cookie dismissal permits rejection, minimal consent or closing the banner. It does not grant acceptance of all tracking consent. Reversible test preferences require `allowTestSettings: true` and a loopback or reserved `.test` origin; this does not permit production account settings or payment/address changes.

## Request guard

```js
const policy = {
  currentUrl: page.url(), allowedOrigin: new URL(startURL).origin,
  guestSession: true, ownedCartItemKeys: new Set(),
};
const guard = createRequestGuard(policy, { onEvent: durableJournal });
await context.route('**/*', guard.route);

guard.throwIfStopped();
const safe = validateAction(freshObservedAction, policy);
await durableJournal({ type: 'action_planned', ref: safe.ref });
// Cart writes or local test preference writes only:
guard.authorize(safe, policy);
try {
  await executeNativeWithIdentityRevalidation(safe);
  await observeAndVerifyOutcome();
} finally {
  guard.finishAction();
}
```

Read-only actions do not call `authorize`. Update the current URL and executor-owned cart ledger after observation; never change the initial allowed origin to follow an unexpected redirect. Attach the guard to a fresh isolated browser context so popup requests are also intercepted. The executor separately rejects downloads, uploads, popups and unsafe native controls, and retains bounded total action/time limits.

Ordinary same-origin GET/HEAD/OPTIONS reads are allowed except dangerous paths/action queries. Dangerous GET links are blocked as well as POSTs. Cross-origin navigation and fetch/XHR are blocked; passive GET/HEAD scripts, styles, images, fonts and media may load.

Cart mutations require a short-lived, single-use, nonforgeable permit for the exact observed form endpoint and method. `createMutationPermit` defaults to five seconds, at most ten. Native form methods supported are GET and POST. Query parameters participate in exact endpoint matching in memory, but never appear in guard diagnostics. The Amazon `handle-buy-box` form may be permitted for an observed add-to-cart action; this grants no permission to a buy-now or checkout control. No wildcard mutation window exists. Missing or dynamically unobserved endpoints remain unsupported.

`classifyRequest` is a read-only inspection helper. Production interception must use `guard.route`, which reserves/consumes the permit, awaits the authorization journal, then continues the request. A permit does not bind or inspect a request body and cannot prove request causation; observed controls, an isolated guest context, single use, short lifetime and post-action verification remain necessary limitations.

Unrelated unpermitted telemetry POSTs are aborted and counted without automatically failing the shopping task. Dangerous navigation/order/account requests set `guard.signal` to aborted; the runner must combine that signal with its own stop signal and call `throwIfStopped()` before actions. A journal failure aborts the request and stops the guard. Receipt counters distinguish these routine aborts from dangerous requests and authorized mutations. No request bodies, headers or credentials are recorded.

The guard is not a substitute for merchant-state verification. A successful click, an authorized HTTP request or a cart-looking label does not prove the right product, variant, quantity or price was added. The independent benchmark verifier must establish those outcomes, and no purchase or payment is authorized by this benchmark.
