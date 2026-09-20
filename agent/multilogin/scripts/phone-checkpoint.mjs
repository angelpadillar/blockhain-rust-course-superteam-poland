import { requireThat, PilotError } from '../src/core.mjs';
import { verifyIdentity } from '../src/login.mjs';

// Scoped operator-assisted checkpoint. The supplied number/code stays in memory.
export async function completePhoneCheckpoint({ page, account, adapter, phone, replacePhone = false, readCommand, onStep }) {
  requireThat(/^\+48\d{9}$/.test(phone || ''), 'polish_phone_required');
  const national = phone.slice(3);
  adapter.redact.add(phone); adapter.redact.add(national);
  const observe = () => adapter.observe();
  const emit = async (phase, snapshot) => {
    const event = { phase, page: adapter.publicPage(snapshot) };
    await onStep(event); console.log(JSON.stringify({ event: phase, page: event.page }));
  };
  const click = async (snapshot, pattern) => {
    const candidates = snapshot.controls.filter(control => control.enabled && control.tag !== 'input' && pattern.test(control.label.trim()));
    requireThat(candidates.length === 1, 'phone_checkpoint_control_not_unique');
    await adapter.execute({ kind: 'submit_login', control: candidates[0] }, snapshot);
  };
  let snapshot = await observe();
  requireThat(new URL(snapshot.url).origin === 'https://www.instagram.com'
    && new URL(snapshot.url).pathname === '/accounts/suspended/', 'phone_checkpoint_missing');
  if (!/enter your mobile number/i.test(snapshot.text) && !snapshot.text.replace(/\D/g, '').includes(national)) {
    requireThat(replacePhone === true, 'phone_replacement_not_requested');
    await onStep({ phase: 'phone_replacement', method: 'user-supplied-replacement', state: 'before' });
    await click(snapshot, /^Update mobile number$/i);
    const editDeadline = Date.now() + 15000;
    do {
      await page.waitForTimeout(500); snapshot = await observe();
      if (/enter your mobile number/i.test(snapshot.text)) break;
    } while (Date.now() < editDeadline);
    requireThat(/enter your mobile number/i.test(snapshot.text), 'phone_edit_form_missing');
  }
  if (/enter your mobile number/i.test(snapshot.text)) {
  const country = snapshot.controls.filter(control => control.enabled && /^[A-Za-z ]+\s+\+\d{1,4}$/.test(control.label.trim()));
  requireThat(country.length === 1, 'phone_country_control_not_unique');
  if (!/\+48$/.test(country[0].label.trim())) {
    await adapter.execute({ kind: 'submit_login', control: country[0] }, snapshot);
    await page.waitForTimeout(600);
    const poland = page.getByText(/^Poland(?:\s*(?:\(\+?48\)|\+48))?$/i);
    const visible = [];
    for (const candidate of await poland.all()) if (await candidate.isVisible()) visible.push(candidate);
    if (visible.length !== 1) {
      await emit('phone_country_selection_needed', await observe());
      throw new PilotError('poland_option_not_unique');
    }
    // Country text has a separate pointer layer. Click the observed row that
    // contains exactly the country and dial code, rather than its text span.
    const rowHandle = await visible[0].evaluateHandle(element => {
      let row = null;
      for (let parent = element; parent && parent !== document.body; parent = parent.parentElement) {
        const text = parent.innerText?.replace(/\s+/g, ' ').trim();
        if (text === 'Poland +48') row = parent;
        else if (row) break;
      }
      return row;
    });
    const row = rowHandle.asElement();
    requireThat(row && await row.isVisible(), 'poland_row_missing');
    await row.click({ timeout: 5000, noWaitAfter: true });
    await rowHandle.dispose();
    await page.waitForTimeout(300);
    snapshot = await observe();
  }
  requireThat(snapshot.controls.some(control => /^(?:PL|Poland)\s*\+48$/i.test(control.label.trim())), 'polish_country_not_selected');
  const fields = snapshot.controls.filter(control => control.tag === 'input' && control.type === 'tel' && control.enabled);
  requireThat(fields.length === 1, 'phone_field_not_unique');
  await fields[0].handle.fill(national, { timeout: 5000 });
  snapshot = await observe();
  await onStep({ phase: 'phone_code_request', country: 'PL', method: 'user-supplied-number', state: 'before' });
  await click(snapshot, /^Send code$/i);
  const deadline = Date.now() + 35000;
  do {
    await page.waitForTimeout(1000); snapshot = await observe();
    if (!/enter your mobile number/i.test(snapshot.text) || /try again later|invalid phone|valid phone|couldn.t send|unable to send/i.test(snapshot.text)) break;
  } while (Date.now() < deadline);
  await emit('phone_code_request_result', snapshot);
  }
  requireThat(!/enter your mobile number/i.test(snapshot.text)
    && /code/i.test(snapshot.text) && /SMS|WhatsApp|sent|confirmation|security code/i.test(snapshot.text), 'phone_code_not_requested');
  requireThat(snapshot.text.replace(/\D/g, '').includes(national), 'phone_delivery_number_mismatch');
  if (/we sent a code to WhatsApp/i.test(snapshot.text)) {
    await onStep({ phase: 'sms_delivery_requested', state: 'before' });
    await click(snapshot, /^Send code via SMS$/i);
    const smsDeadline = Date.now() + 35000;
    do {
      await page.waitForTimeout(1000); snapshot = await observe();
      if (!/we sent a code to WhatsApp/i.test(snapshot.text)) break;
    } while (Date.now() < smsDeadline);
    await emit('sms_delivery_result', snapshot);
    requireThat(!/we sent a code to WhatsApp/i.test(snapshot.text) && /code/i.test(snapshot.text)
      && /SMS|sent|confirmation/i.test(snapshot.text), 'sms_delivery_not_confirmed');
  }
  const codeFields = page.locator('input:not([type="hidden"]):visible,textarea:visible,[contenteditable="true"]:visible');
  console.log(JSON.stringify({ event: 'sms_fields', fields: await codeFields.evaluateAll(elements => elements.map(element => ({
    tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), label: element.getAttribute('aria-label') || element.getAttribute('placeholder'),
  }))) }));
  console.log(JSON.stringify({ event: 'awaiting_user_sms_code' }));
  const command = await readCommand(600000);
  if (command.action === 'stop') throw new PilotError('sms_code_missing');
  requireThat(command.action === 'sms-code' && /^\d{4,8}$/.test(command.code || ''), 'invalid_sms_code');
  adapter.redact.add(command.code);
  snapshot = await observe();
  requireThat(new URL(snapshot.url).origin === 'https://www.instagram.com'
    && /code/i.test(snapshot.text) && !/enter your mobile number/i.test(snapshot.text)
    && snapshot.text.replace(/\D/g, '').includes(national), 'sms_screen_changed');
  const codes = page.locator('input:not([type="hidden"]):visible,textarea:visible,[contenteditable="true"]:visible');
  requireThat(await codes.count() === 1, 'sms_code_field_not_unique');
  await codes.fill(command.code, { timeout: 5000 });
  snapshot = await observe();
  await onStep({ phase: 'sms_code_submitted', method: 'user-supplied-code', state: 'before' });
  await click(snapshot, /^(?:Confirm|Next|Submit|Continue|Verify)$/i);
  const verifyDeadline = Date.now() + 35000;
  do {
    await page.waitForTimeout(1000); snapshot = await observe();
    if (verifyIdentity(account, snapshot) || /incorrect code|invalid code|try again later/i.test(snapshot.text)) break;
  } while (Date.now() < verifyDeadline);
  await emit('phone_checkpoint_after', snapshot);
  if (verifyIdentity(account, snapshot)) return { verified: true, steps: 2 };
  throw new PilotError(/incorrect code|invalid code/i.test(snapshot.text) ? 'invalid_verification_code' : 'phone_checkpoint_next_stage');
}
