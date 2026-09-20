import { Jev } from "./jev.mjs";
import { formatElements } from "./snapshot.mjs";

const ACTION_CRITERIA = {
  click: "Click the selected element (ONLY valid for interactive elements: button, link, checkbox, radio, tab, option, menu item, combobox; NOT for text inputs).",
  type: "Enter text into the selected input or textarea (ONLY valid for textbox/searchbox/combobox elements; to submit a form after typing choose click on the submit button or press_key Enter).",
  scroll_down: "Scroll down because the target is not visible in the current viewport.",
  scroll_up: "Scroll up to reveal content above the viewport.",
  press_key: "Press a keyboard key (see key options) on the focused element or page. Pressing Enter while text focus is in a search/text field submits it; Escape closes dialogs.",
  back: "Go back to the previous page.",
  wait: "Wait briefly for the page to load or update.",
  done: "The GOAL is already fully achieved. No further action needed.",
  stuck: "The GOAL cannot be progressed from this state (blocked, missing, ambiguous, unsafe).",
};

const KEY_CHOICES = {
  Enter: "Enter / submit the focused form or field",
  Tab: "Move focus to the next element",
  Escape: "Close a dialog, popup, or overlay",
  ArrowDown: "Move selection down",
  ArrowUp: "Move selection up",
  Space: "Press space (e.g. toggle a checkbox)",
  PageDown: "Scroll a full page down",
  PageUp: "Scroll a full page up",
};

export class JevBrowserAgent {
  constructor({ session, jev, minConfidence = 0.5, prevOkThreshold = 0.35, doneThreshold = 0.6 } = {}) {
    this.session = session;
    this.jev = jev ?? new Jev();
    this.minConfidence = minConfidence;
    this.prevOkThreshold = prevOkThreshold;
    this.doneThreshold = doneThreshold;
    this.history = [];
    this.lastSnapshot = null;
  }

  buildState(snap, goal, { prev, texts }) {
    const lines = [];
    lines.push(`GOAL: ${goal}`);
    lines.push("");
    lines.push("CURRENT PAGE");
    lines.push(`URL: ${snap.url}`);
    lines.push(`TITLE: ${snap.title}`);
    if (snap.dialogs) lines.push(`DIALOGS OPEN: ${snap.dialogs}`);
    if (snap.focusRef) lines.push(`FOCUS: ${snap.focusRef}`);
    lines.push(`SCROLL: ${snap.scrollY} of ${Math.max(snap.scrollHeight - snap.viewportH, 0)}`);
    if (snap.textSample) lines.push(`PAGE_TEXT: ${snap.textSample}`);
    if (texts?.length)
      lines.push(
        "TEXTS (available values for the type action):\n" +
          texts.map((t, i) => `  [t${i}] ${JSON.stringify(typeof t === "string" ? t : t.value)}${typeof t === "object" && t.note ? ` (${t.note})` : ""}`).join("\n")
      );
    lines.push("");
    lines.push(`CANDIDATES (${snap.elements.length} shown, best matches first in the list order):`);
    lines.push(formatElements(snap.elements) || " (none)");
    if (this.history.length) {
      lines.push("");
      lines.push("HISTORY (last actions):");
      for (const h of this.history.slice(-3)) lines.push(` ${h}`);
    }
    if (prev) {
      lines.push("");
      lines.push("PREVIOUS ACTION:");
      lines.push(
        ` action=${prev.action}${prev.ref ? ` ref=${prev.ref}` : ""}${prev.label ? ` "${prev.label}"` : ""}${prev.text != null ? ` text=${JSON.stringify(prev.text)}` : ""}${prev.key ? ` key=${prev.key}` : ""}`
      );
      lines.push(` result: ${prev.outcome}`);
    }
    return lines.join("\n");
  }

  buildQuestions(snap, texts, prev, hint) {
    const note = hint ? ` IMPORTANT: ${hint}` : "";
    const questions = {
      action: {
        type: "choice",
        instructions:
          "What single next action moves the GOAL forward? Prefer the smallest decisive action. Choose done only if the GOAL is fully achieved; choose stuck only if no action can progress it." +
          note,
        criteria: ACTION_CRITERIA,
      },
      goal_achieved: {
        type: "noul",
        instructions:
          "The GOAL is fully and verifiably achieved in the CURRENT PAGE state (visible evidence, not assumptions). Partial progress does not count.",
      },
    };

    if (prev) {
      questions.prev_ok = {
        type: "noul",
        instructions:
          "The PREVIOUS ACTION succeeded and its intended effect is reflected in the CURRENT PAGE state. A no-op, an error shown, or no change means low probability.",
      };
    }

    if (snap.elements.length) {
      const criteria = {};
      for (const e of snap.elements) criteria[e.ref] = elementDescription(e);
      questions.element = {
        type: "choice",
        instructions:
          "Which candidate element should the action target? Use the element's label, role and position. Choose the element that best matches the GOAL." +
          (hint ? ` ${hint}` : ""),
        criteria,
      };
    }

    questions.key = {
      type: "choice",
      instructions: "If press_key is chosen, which key should be pressed?",
      criteria: KEY_CHOICES,
    };

    if (texts && texts.length > 1) {
      const typeFields = snap.elements
        .filter((e) => e.role === "textbox" || e.role === "searchbox" || e.role === "combobox")
        .slice(0, 16);
      if (typeFields.length) {
        const criteria = {};
        for (const e of typeFields) {
          const state = e.value != null ? ` [currently: "${e.value}" — already contains text]` : " [currently: EMPTY]";
          texts.forEach((t, i) => {
            criteria[`${e.ref}|t${i}`] = `enter ${textLabel(t)} into ${describeShort(e)}${state}`;
          });
        }
        questions.type_target = {
          type: "choice",
          instructions:
            'If the chosen action is "type", which field must receive which supplied TEXT next? The answer binds the field AND the text. Do NOT choose a field that is already filled with the correct value — pick a field that still needs its text. If the action is not type, you may pick any option.',
          criteria,
        };
      }
    }
    return questions;
  }

  async decide(snap, goal, { prev, texts, hint }) {
    const state = this.buildState(snap, goal, { prev, texts });
    const questions = this.buildQuestions(snap, texts, prev, hint);
    this.lastSnapshot = snap;
    const resp = await this.jev.ask(state, questions);
    const a = resp.answers;
    const doneProb = a.goal_achieved?.noul ?? 0;
    const prevOk = a.prev_ok ? a.prev_ok.noul : null;
    const action = a.action.choice;
    const actionConf = confidenceOf(a.action);
    let element = a.element?.choice ?? null;
    let elementConf = a.element ? confidenceOf(a.element) : null;
    const key = a.key?.choice ?? null;
    let textChoice;
    let pairBound = false;

    if (a.type_target && action === "type") {
      const [ref, ti] = String(a.type_target.choice).split("|");
      if (ref && ti) {
        element = ref;
        textChoice = texts[Number(ti.slice(1))];
        elementConf = confidenceOf(a.type_target);
        pairBound = true;
      }
    } else if (a.text_choice && texts) {
      textChoice = texts[Number(String(a.text_choice.choice).slice(1))];
    }

    const reasons = [];
    let status = "acted";
    let needsAgent = false;

    if (action === "done" || (doneProb >= this.doneThreshold && action !== "click" && action !== "type")) {
      status = "done";
      if (action === "done" && doneProb < 0.5) {
        status = "escalate";
        return {
          status,
          action: { type: "done" },
          decision: { action, actionConf, element, elementConf, doneProb, prevOk, key, textChoice, pairBound },
          needsAgent: true,
          reasons: [`done with low goal confidence (${doneProb.toFixed(2)}) — confirm the page state`],
          usage: resp.usage,
          stateChars: state.length,
          jevLatencyMs: resp.latencyMs,
          raw: simplifyAnswers(a),
        };
      }
      return {
        status,
        action: { type: "done" },
        decision: { action, actionConf, element, elementConf, doneProb, prevOk, key, textChoice, pairBound },
        needsAgent: false,
        reasons: [],
        usage: resp.usage,
        stateChars: state.length,
        jevLatencyMs: resp.latencyMs,
        raw: simplifyAnswers(a),
      };
    }

    if (action === "stuck") {
      needsAgent = true;
      reasons.push("jev_stuck");
      status = "escalate";
    }

    if (actionConf != null && actionConf < this.minConfidence) {
      needsAgent = true;
      reasons.push("low_action_confidence=" + actionConf.toFixed(2));
    }
    const target = element ? snap.elements.find((e) => e.ref === element) : null;
    const reversible = !!target && ["option", "checkbox", "radio", "switch"].includes(target.role);
    if ((action === "click" || action === "type") && !element) {
      needsAgent = true;
      reasons.push("no_element_selected");
    } else if ((action === "click" || action === "type") && elementConf != null) {
      const floor = reversible ? this.minConfidence * 0.6 : this.minConfidence;
      if (elementConf < floor) {
        needsAgent = true;
        reasons.push("low_element_confidence=" + elementConf.toFixed(2));
      } else if (elementConf < this.minConfidence) {
        reasons.push(`low_element_confidence=${elementConf.toFixed(2)} accepted (reversible: ${target.role})`);
      }
    }
    if (prevOk != null && prevOk < this.prevOkThreshold) {
      const neutralPrev = prev?.action === "wait" || prev?.action === "scroll_down" || prev?.action === "scroll_up";
      if (prev?.evidence_changed || neutralPrev) {
        reasons.push(`prev_ok=${prevOk.toFixed(2)} not blocking (${prev?.evidence_changed ? "deterministic change" : "neutral previous action"})`);
      } else {
        needsAgent = true;
        reasons.push("prev_action_suspect=" + prevOk.toFixed(2));
      }
    }
    if (action === "type" && texts?.length === 0 && !textChoice) {
      needsAgent = true;
      reasons.push("text_required");
      status = "escalate";
    }

    let invalid = false;
    let invalidReason = null;
    if (action === "type" && element) {
      const target = snap.elements.find((e) => e.ref === element);
      const okRoles = ["textbox", "searchbox", "combobox"];
      if (!target || !okRoles.includes(target.role)) {
        invalid = true;
        invalidReason = `action "type" targeted "${target ? target.role || target.tag : element}" which is not a text input`;
      }
    }
    if (action === "click" && element) {
      const target = snap.elements.find((e) => e.ref === element);
      if (target && (target.role === "textbox" || target.role === "searchbox")) {
        invalid = true;
        invalidReason = `action "click" targeted a ${target.role} ("${target.label}"); text inputs are filled with "type"`;
      }
    }

    if (needsAgent && status !== "done" && !invalid) status = "escalate";

    return {
      status: invalid ? "invalid" : status,
      invalid,
      invalidReason,
      action: {
        type: action,
        ref: element,
        key: action === "press_key" ? key : undefined,
        text: action === "type" ? textFrom(texts, textChoice) : undefined,
      },
      decision: { action, actionConf, element, elementConf, doneProb, prevOk, key, textChoice, pairBound },
      needsAgent,
      reasons,
      usage: resp.usage,
      stateChars: state.length,
      jevLatencyMs: resp.latencyMs,
      raw: simplifyAnswers(a),
    };
  }

  async execute(action) {
    switch (action.type) {
      case "done":
      case "stuck":
        return { ok: true, noop: true, latencyMs: 0 };
      case "scroll_down":
        return this.session.act({ type: "scroll", direction: "down" });
      case "scroll_up":
        return this.session.act({ type: "scroll", direction: "up" });
      case "press_key":
        return this.session.act({ type: "press", key: action.key || "Enter" });
      case "back":
        return this.session.act({ type: "back" });
      case "wait":
        return this.session.act({ type: "wait", ms: 500 });
      case "click":
      case "type":
        return this.session.act(action);
      default:
        return { ok: false, reason: "unsupported:" + action.type, latencyMs: 0 };
    }
  }

  async step(goal, { texts = [], minConfidence, prev = null } = {}) {
    const t0 = performance.now();
    const snap = await this.session.snapshot({ goal });
    let decision = await this.decide(snap, goal, { prev: prev ?? null, texts });
    let decideMs = decision.jevLatencyMs;
    let tokensIn = decision.usage?.input_tokens ?? 0;
    let tokensOut = decision.usage?.output_tokens ?? 0;

    const isSoftEscalate = (d) =>
      d.status === "escalate" && d.needsAgent && d.reasons.every((r) => /^low_(action|element)_confidence/.test(r));

    if (decision.invalid || isSoftEscalate(decision)) {
      const hint = buildRetryHint(decision, snap, prev);
      const retry = await this.decide(snap, goal, { prev: prev ?? null, texts, hint });
      decideMs += retry.jevLatencyMs;
      tokensIn += retry.usage?.input_tokens ?? 0;
      tokensOut += retry.usage?.output_tokens ?? 0;
      if (retry.invalid) {
        retry.status = "escalate";
        retry.needsAgent = true;
        retry.reasons.push("action_element_mismatch: " + retry.invalidReason);
      } else if (isSoftEscalate(retry)) {
        retry.reasons.push("low_confidence_after_retry");
      }
      retry.retried = true;
      decision = retry;
    }

    if (decision.status !== "acted") {
      return {
        status: decision.status,
        step: this.history.length + 1,
        action: decision.action,
        decision: decision.decision,
        needs_agent: decision.needsAgent,
        reasons: decision.reasons,
        page: { url: snap.url, title: snap.title, text: snap.textSample.slice(0, 300) },
        candidates: compactCandidates(snap.elements, 25),
        latency_ms: { snapshot: snap.latencyMs, decide: round(decideMs), total: round(performance.now() - t0) },
        tokens: { in: tokensIn, out: tokensOut },
      };
    }

    const before = await this.session.softState();
    const exec = await this.execute(decision.action);
    const after = await this.session.softState();
    const outcome = diffState(before, after);
    const outcomeText = outcomeTextFor(exec, outcome);
    const stateHash = `${after.textHash}:${after.inputHash}:${after.focusRef ?? ""}`;
    this.history.push(
      `${decision.action.type}${decision.action.ref ? ` ${decision.action.ref}` : ""}${exec.label ? ` "${exec.label}"` : ""} -> ${outcomeText}`
    );

    return {
      status: exec.ok ? "acted" : "error",
      step: this.history.length,
      action: decision.action,
      decision: decision.decision,
      needs_agent: decision.needsAgent,
      reasons: decision.reasons,
      outcome,
      outcome_text: outcomeText,
      state_hash: stateHash,
      exec,
      page: { url: after.url, title: after.title, text: snap.textSample.slice(0, 300) },
      candidates: compactCandidates(snap.elements, 25),
      latency_ms: {
        snapshot: snap.latencyMs,
        decide: round(decideMs),
        action: exec.latencyMs,
        verify: round(after.latencyMs),
        total: round(performance.now() - t0),
      },
      tokens: { in: tokensIn, out: tokensOut },
    };
  }

  async runGoal(goal, { maxSteps = 10, texts = [], stopOnEscalate = true } = {}) {
    const trace = [];
    let prev = null;
    this.history = [];

    for (let i = 0; i < maxSteps; i++) {
      const r = await this.step(goal, { texts, prev });
      trace.push(summarizeStep(r));
      prev = r.status === "acted" && r.action && r.action.type !== "done"
        ? {
            action: r.action.type,
            ref: r.action.ref,
            key: r.action.key,
            text: r.action.text,
            label: r.exec?.label,
            outcome: r.outcome_text,
            evidence_changed: !!(r.outcome && (r.outcome.url_changed || r.outcome.text_changed || r.outcome.inputs_changed)),
          }
        : null;

      if (r.status === "done") return { ok: true, status: "done", steps: trace.length, trace };
      if (r.status === "error" || r.status === "escalate") {
        if (stopOnEscalate) return { ok: false, status: r.status, needs_agent: true, steps: trace.length, last: r, trace };
      }
      if (r.needs_agent && stopOnEscalate) return { ok: false, status: "escalate", needs_agent: true, steps: trace.length, last: r, trace };

      const fingerprints = trace.map((s) => s.fingerprint).filter(Boolean);
      if (fingerprints.length >= 3 && fingerprints.slice(-3).every((f) => f === fingerprints.at(-1)))
        return { ok: false, status: "loop", needs_agent: true, steps: trace.length, last: r, trace };
    }
    return { ok: false, status: "max_steps", needs_agent: true, steps: trace.length, last: trace.at(-1), trace };
  }

  async askPage(questions, { goal = "", maxCandidates = 120 } = {}) {
    const snap = await this.session.snapshot({ goal, maxCandidates });
    const state = [
      `URL: ${snap.url}`,
      `TITLE: ${snap.title}`,
      snap.textSample ? `PAGE_TEXT: ${snap.textSample}` : "",
      `CANDIDATES (${snap.elements.length}):`,
      formatElements(snap.elements) || " (none)",
    ]
      .filter(Boolean)
      .join("\n");
    const resp = await this.jev.ask(state, questions);
    return { url: snap.url, title: snap.title, answers: resp.answers, usage: resp.usage, latencyMs: resp.latencyMs, stateChars: state.length };
  }
}

function elementDescription(e) {
  const bits = [e.tag];
  if (e.role && e.role !== e.tag) bits.push(`(${e.role})`);
  bits.push(`"${e.label}"`);
  if (e.value != null) bits.push(`value="${e.value}"`);
  if (e.href) bits.push(`-> ${e.href}`);
  if (e.flags?.length) bits.push(`[${e.flags.join(",")}]`);
  return bits.join(" ") + ` @(${e.bbox[0]},${e.bbox[1]})`;
}

function confidenceOf(answer) {
  if (!answer) return null;
  if (typeof answer.confidence === "number") return answer.confidence;
  const probs = answer.probabilities ? Object.values(answer.probabilities) : [];
  return probs.length ? Math.max(...probs) : null;
}

function textFrom(texts, textChoice) {
  const pick = textChoice != null ? textChoice : texts?.length === 1 ? texts[0] : undefined;
  if (pick == null) return undefined;
  return typeof pick === "string" ? pick : pick.value;
}

function textLabel(t) {
  const value = typeof t === "string" ? t : t.value;
  const note = typeof t === "object" && t.note ? ` (${t.note})` : "";
  return JSON.stringify(value) + note;
}

function describeShort(e) {
  return `${e.ref} ${e.tag}${e.role && e.role !== e.tag ? `(${e.role})` : ""} "${e.label}"`;
}

function buildRetryHint(decision, snap, prev) {
  const bits = [];
  const el = decision.raw?.element;
  if (el?.probs) {
    const top = Object.entries(el.probs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    bits.push(
      "Your previous element choice was uncertain between: " +
        top
          .map(([ref, p]) => {
            const e = snap.elements.find((x) => x.ref === ref);
            return `${ref} "${e?.label ?? "?"}" (p=${p})`;
          })
          .join(" and ") +
        "."
    );
  }
  if (prev?.outcome)
    bits.push(
      `The previous action (${prev.action}${prev.ref ? " " + prev.ref : ""}) gave: ${prev.outcome}${prev.evidence_changed ? " — treat it as successful progress" : ""}.`
    );
  bits.push(
    "Re-read the GOAL exactly and choose the single element whose label matches the goal wording (the correct label usually appears verbatim in the goal). Give a high-confidence answer when the match is exact."
  );
  return bits.join(" ");
}

function simplifyAnswers(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v.type === "choice") out[k] = { choice: v.choice, confidence: round2(v.confidence), probs: topProbs(v.probabilities, 4) };
    else if (v.type === "noul") out[k] = { noul: round2(v.noul) };
    else if (v.type === "score") out[k] = { score: round2(v.score), confidence: round2(v.confidence) };
  }
  return out;
}

function topProbs(probs, n) {
  if (!probs) return undefined;
  return Object.fromEntries(
    Object.entries(probs)
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([k, v]) => [k, round2(v)])
  );
}

function diffState(before, after) {
  return {
    url_changed: before.url !== after.url,
    text_changed: before.textHash !== after.textHash,
    inputs_changed: before.inputHash !== after.inputHash,
    dialogs: after.dialogs,
    dialogs_changed: before.dialogs !== after.dialogs,
    focus: after.focusRef,
    scrolled: before.scrollY !== after.scrollY,
  };
}

function outcomeTextFor(exec, d) {
  if (exec?.noop) return "no-op";
  const bits = [];
  if (!exec?.ok) bits.push("FAILED:" + (exec?.reason || "unknown"));
  if (d.url_changed) bits.push("url changed");
  if (d.text_changed) bits.push("text changed");
  if (d.inputs_changed) bits.push("inputs changed");
  if (d.dialogs_changed) bits.push(`dialogs=${d.dialogs}`);
  if (d.scrolled) bits.push("scrolled");
  if (!bits.length) bits.push("no visible change");
  return bits.join(", ");
}

function summarizeStep(r) {
  const t = r.action?.type;
  const conf = t === "click" || t === "type" ? r.decision?.elementConf ?? r.decision?.actionConf : r.decision?.actionConf;
  return {
    step: r.step,
    status: r.status,
    action: t + (r.action?.ref ? ` ${r.action.ref}` : ""),
    label: r.exec?.label ?? null,
    confidence: conf ?? null,
    outcome: r.outcome_text ?? null,
    needs_agent: r.needs_agent ?? false,
    latency_ms: r.latency_ms ?? null,
    tokens: r.tokens ?? null,
    fingerprint: (r.state_hash ?? r.outcome) ? [r.action?.type, r.action?.ref, r.state_hash ?? JSON.stringify(r.outcome)].join("|") : null,
  };
}

function compactCandidates(elements, n) {
  return elements.slice(0, n).map((e) => ({ ref: e.ref, desc: elementDescription(e) }));
}

function round(n) {
  return Math.round((n ?? 0) * 10) / 10;
}
function round2(n) {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : n;
}
