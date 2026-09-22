// G5: repeatable unexpected-browser-state fixtures. Each fixture is a scripted
// page double, so every configuration runs against byte-identical states and the
// comparison is about behaviour, not about browser timing.
//
// Nothing here provokes a real challenge: the CAPTCHA fixture is a synthetic page
// that only has to be CLASSIFIED.
const origin = 'https://www.youtube.com';
const challengeOrigin = 'https://accounts.google.com';

export const identityFrame = { url: `${origin}/`,
  text: 'fixture@example.com Switch account Sign out Google Account', challengeFrame: false, controls: [] };
const homeFrame = (text, controls = []) => ({ url: `${origin}/`, text, challengeFrame: false, controls });
const button = (label, extra = {}) => ({ tag: 'button', type: '', label, name: extra.name || '',
  enabled: extra.enabled !== false, correct: extra.correct === true });
const link = (label, href) => ({ tag: 'a', type: '', label, name: '', href, enabled: true });
const wrongFrame = () => homeFrame('Something went wrong');

export const fixtureNames = ['ambiguous_buttons', 'dynamic_rerender', 'visual_onboarding',
  'weak_dom_semantics', 'unfamiliar_layout', 'postcondition_ambiguity', 'captcha_detection'];

export function buildFixture(name) {
  switch (name) {
    case 'ambiguous_buttons':
      // The flow offers no capability that names a specific identical button, so a
      // model can only abstain here (a licence to guess between two identical
      // controls is exactly what this design refuses).
      return { name, label: 'ambiguous buttons: two identical "Continue" controls, only one is right',
        expectation: { recovered: false, frontierReached: true, wrongActions: 0 },
        frames: [homeFrame('Choose how to continue', [button('Continue', { correct: true }),
          button('Continue', { correct: false })]), wrongFrame(), identityFrame],
        decisionHint: { correctLabel: 'Continue' } };
    case 'dynamic_rerender':
      // The page re-renders its volatile text between the decision observation and
      // the immediate pre-dispatch re-read, and the control the decision named is
      // still there: the action must still be executed (the page identity, not the
      // text, is what a decision depends on).
      return { name, label: 'dynamic re-render: volatile text changes between decision and dispatch',
        expectation: { recovered: true },
        mutateAfterReads: { after: 2, text: 'Cookies re-rendered 12:04' },
        frames: [homeFrame('Cookies', [button('Decline optional cookies', { correct: true })]),
          identityFrame] };
    case 'visual_onboarding':
      return { name, label: 'visual onboarding: a harmless interstitial must be dismissed safely',
        expectation: { recovered: true, capability: 'dismiss_onboarding' },
        frames: [{ url: 'https://gds.google.com/web/pgc', text: 'Add a profile picture Skip',
          challengeFrame: false, controls: [button('Skip', { correct: true })] }, identityFrame] };
    case 'weak_dom_semantics':
      // No permitted candidate exists for an unlabeled control, so the runtime
      // cannot act on it: the honest outcome is an abstention, never a guess.
      return { name, label: 'control visible but with no usable DOM name (icon only)',
        expectation: { recovered: false, frontierReached: true, wrongActions: 0, halted: true },
        frames: [homeFrame('Home', [button('', { correct: false })]), identityFrame] };
    case 'unfamiliar_layout':
      return { name, label: 'unfamiliar layout: unfamiliar labels, no rule matches',
        expectation: { recovered: false, frontierReached: true, wrongActions: 0, halted: true },
        frames: [{ url: `${origin}/feed/library`, text: 'Biblioteka Zasoby', challengeFrame: false,
          controls: [link('Otwórz', `${origin}/feed/library`)] }, identityFrame] };
    case 'postcondition_ambiguity':
      // The action is dispatched, the postcondition is NOT observed, and the
      // runtime must report that honestly instead of claiming success.
      return { name, label: 'the click is accepted but the page never changes (ambiguous postcondition)',
        expectation: { recovered: false, postconditionFailed: true },
        frames: [homeFrame('Home', [button('Account menu', { correct: true })])], noChangeOnClick: true };
    case 'captcha_detection':
      return { name, label: 'CAPTCHA / reCAPTCHA: classification only, never solved',
        expectation: { recovered: false, humanRequired: true, wrongActions: 0 },
        wrongKinds: ['click:any'],
        frames: [{ url: `${challengeOrigin}/signin/v2/challenge`, challengeFrame: true,
          text: 'Verify you are human. Confirm you are not a robot. reCAPTCHA',
          controls: [button('I am not a robot'), button('Continue')] }] };
    default:
      throw new Error(`unknown fixture: ${name}`);
  }
}

// A page double driven by the fixture frames. A click only advances when it hits
// the fixture's correct control, and a wrong click is recorded, so a wrong action
// is visible in the result instead of being silently absorbed.
export function createFixturePage(fixture) {
  const state = { index: 0, clicks: [], wrong: 0 };
  const frame = () => fixture.frames[Math.min(state.index, fixture.frames.length - 1)];
  let reads = 0;
  // A fixture may mutate its volatile text after a number of reads, which models a
  // client-rendered page without changing the control set.
  const observeFrame = () => {
    reads++;
    if (fixture.mutateAfterReads && reads > fixture.mutateAfterReads.after) {
      return { ...frame(), text: fixture.mutateAfterReads.text };
    }
    return frame();
  };
  const advance = () => { state.index = Math.min(state.index + 1, fixture.frames.length - 1); };
  const handles = (observed = frame()) => observed.controls.map(control => {
    const element = { tagName: control.tag.toUpperCase(), id: control.name || '', innerText: control.label,
      labels: [], disabled: control.enabled === false, readOnly: false, required: false, form: null,
      href: control.href || '',
      getAttribute: name => (name === 'aria-label' ? control.label : name === 'type' ? control.type
        : name === 'name' ? control.name : null),
      querySelector: () => null };
    return { isVisible: async () => true, isEnabled: async () => control.enabled !== false,
      dispose: async () => {}, evaluate: async fn => fn(element),
      click: async () => {
        state.clicks.push(control.label || '(unlabeled)');
        if (control.correct === true && !fixture.noChangeOnClick) advance();
        else if (control.correct !== true) state.wrong++;
      },
      fill: async value => { state.clicks.push(`fill:${control.name || control.label}`); } };
  });
  return { state, frame,
    url: () => frame().url,
    goto: async url => { frame().url = url; return { status: () => 200 }; },
    $$: async () => { const observed = observeFrame(); return handles(observed); },
    locator: () => ({ count: async () => (frame().challengeFrame ? 1 : 0), first() { return this; },
      innerText: async () => frame().text }),
    on: () => {}, off: () => {} };
}
