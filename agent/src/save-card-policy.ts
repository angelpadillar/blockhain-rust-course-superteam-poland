export interface SaveCardControlState {
  promptVisible: boolean;
  controlVisible: boolean;
  checked: boolean | null;
}

/**
 * An explicit, visible, unchecked opt-in is safe: the card will not be stored
 * unless somebody affirmatively checks it. A checked, mandatory, or
 * unverifiable storage choice fails closed.
 */
export function assertSaveCardDisabled(state: SaveCardControlState): void {
  if (!state.promptVisible) return;
  if (!state.controlVisible || state.checked === null) {
    throw new Error(
      "card storage was offered but an optional unchecked control could not be verified",
    );
  }
  if (state.checked) {
    throw new Error("card storage is enabled; payment is blocked by policy");
  }
}
