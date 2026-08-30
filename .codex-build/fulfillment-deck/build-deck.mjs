import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "/Users/buena/Documents/ChatGPT/blockhain-rust-course-superteam-poland";
const BUILD = path.join(ROOT, ".codex-build/fulfillment-deck");
const RENDER = path.join(BUILD, "rendered");
const OUT = path.join(ROOT, "Fulfillment-Agent-Solana-Demo.pptx");

const IMG_CHECKOUT = path.join(ROOT, "agent/out/screenshots/glovo-final-checkout.jpg");
const IMG_CONFIRM = path.join(ROOT, "agent/out/screenshots/glovo-confirmation.jpg");
const IMG_DELIVERED = path.join(ROOT, "agent/out/screenshots/glovo-delivered.jpg");
const IMG_VIDEO_POSTER = path.join(ROOT, "presentation-assets/poster-25.jpg");
const VIDEO_URI = "file:///Users/buena/Documents/ChatGPT/blockhain-rust-course-superteam-poland/presentation-assets/Poland%20Agent%20got%20hands.m4v";

const W = 1280;
const H = 720;
const C = {
  ink: "#111111",
  muted: "#5B6168",
  light: "#F3F4F5",
  rule: "#D9DDE1",
  blue: "#6DCBF4",
  blueStrong: "#3D8DFF",
  green: "#35B88F",
  greenLight: "#DDF6EE",
  amber: "#F2B84B",
  amberLight: "#FFF1D4",
  red: "#E45757",
  redLight: "#FFE3E3",
  white: "#FFFFFF",
  black: "#000000",
};
const FONT = "Helvetica Neue";

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function box(slide, x, y, w, h, fill = C.white, line = C.rule, radius = 18, name) {
  return slide.shapes.add({
    geometry: "roundRect",
    name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: line, width: 1 },
    borderRadius: radius,
  });
}

function addText(slide, text, x, y, w, h, opts = {}) {
  const s = slide.shapes.add({
    geometry: "textbox",
    name: opts.name,
    position: { left: x, top: y, width: w, height: h },
    fill: opts.fill ?? "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  s.text = text;
  s.text.style = {
    fontSize: opts.size ?? 24,
    bold: opts.bold ?? false,
    color: opts.color ?? C.ink,
    alignment: opts.align ?? "left",
    verticalAlignment: opts.vAlign ?? "top",
    lineSpacing: opts.lineSpacing ?? 1,
    autoFit: opts.autoFit ?? "shrinkText",
    wrap: "square",
    insets: opts.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
    typeface: opts.typeface ?? FONT,
  };
  return s;
}

function addRule(slide, x, y, w, color = C.rule, weight = 1) {
  return slide.shapes.add({
    geometry: "line",
    position: { left: x, top: y, width: w, height: 0 },
    fill: "none",
    line: { style: "solid", fill: color, width: weight },
  });
}

function addHeader(slide, title, kicker, number, dark = false) {
  const ink = dark ? C.white : C.ink;
  const muted = dark ? "#AAB4BE" : C.muted;
  if (kicker) addText(slide, kicker.toUpperCase(), 72, 38, 620, 22, { size: 13, bold: true, color: dark ? C.blue : C.blueStrong });
  addText(slide, title, 72, 72, 1136, 82, { size: 42, bold: true, color: ink, lineSpacing: 0.95 });
  addText(slide, String(number).padStart(2, "0"), 1160, 42, 48, 22, { size: 13, bold: true, color: muted, align: "right" });
}

function addFooter(slide, text = "SUPERVISED FULFILLMENT • KRAKÓW • 30 AUG 2026", dark = false) {
  addRule(slide, 72, 675, 1136, dark ? "#33404A" : C.rule, 1);
  addText(slide, text, 72, 687, 1136, 16, { size: 11, bold: true, color: dark ? "#8E9AA5" : "#8A9096", align: "right" });
}

function notes(slide, body, sources = []) {
  const src = sources.length ? `\n\n[Sources]\n${sources.map((s) => `- ${s}`).join("\n")}` : "";
  slide.speakerNotes.textFrame.setText(`${body}${src}`);
  slide.speakerNotes.setVisible(true);
}

function pill(slide, text, x, y, w, fill, color = C.ink) {
  box(slide, x, y, w, 32, fill, fill, 16);
  addText(slide, text, x, y + 6, w, 20, { size: 14, bold: true, color, align: "center" });
}

function addImage(slide, imageBytes, x, y, w, h, fit = "contain", alt = "") {
  box(slide, x - 1, y - 1, w + 2, h + 2, C.white, C.rule, 16);
  return slide.images.add({
    blob: imageBytes,
    contentType: "image/jpeg",
    alt,
    fit,
    position: { left: x, top: y, width: w, height: h },
    geometry: "roundRect",
    borderRadius: 15,
  });
}

function metric(slide, value, label, x, y, w, opts = {}) {
  addText(slide, value, x, y, w, 68, { size: opts.valueSize ?? 52, bold: true, color: opts.color ?? C.ink, align: opts.align ?? "left" });
  addText(slide, label, x, y + 70, w, 54, { size: 19, color: opts.labelColor ?? C.muted, align: opts.align ?? "left", lineSpacing: 1.05 });
}

function shortSig(sig) {
  return `${sig.slice(0, 7)}…${sig.slice(-5)}`;
}

async function main() {
  await fs.mkdir(RENDER, { recursive: true });
  const checkoutBytes = await fs.readFile(IMG_CHECKOUT);
  const confirmationBytes = await fs.readFile(IMG_CONFIRM);
  const deliveredBytes = await fs.readFile(IMG_DELIVERED);
  const videoPosterBytes = await fs.readFile(IMG_VIDEO_POSTER);
  const p = Presentation.create({ slideSize: { width: W, height: H } });

  // 1 — Cover
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    s.shapes.add({ geometry: "rect", position: { left: 0, top: 0, width: 22, height: H }, fill: C.blueStrong, line: { style: "solid", fill: C.blueStrong, width: 0 } });
    addText(s, "SUPERTEAM KRAKÓW • SOLANA PoC", 76, 64, 640, 24, { size: 14, bold: true, color: C.blueStrong });
    addText(s, "An AI agent bought\ndrinks—and Solana\nrecorded the lifecycle", 76, 138, 940, 300, { size: 64, bold: true, lineSpacing: 0.9 });
    addText(s, "Supervised web fulfillment: exact quote approval, email 3DS, purchase evidence, and physical delivery.", 80, 482, 900, 76, { size: 25, color: C.muted, lineSpacing: 1.1 });
    pill(s, "REAL ORDER", 80, 604, 130, C.greenLight, "#167B60");
    pill(s, "REAL CARD", 224, 604, 126, C.amberLight, "#8A5900");
    pill(s, "LOCAL SOLANA", 364, 604, 154, "#E6F5FC", "#126A91");
    addText(s, "30 AUG 2026", 1054, 648, 154, 22, { size: 13, bold: true, color: C.muted, align: "right" });
    notes(s,
      "Open with the outcome: the system turned a plain-language intent into a physical delivery. The interesting part is not just browser automation—the system kept payment supervised and recorded each authorization boundary on Solana.",
      ["Local demo artifacts under agent/out/", "User-confirmed in-person delivery, 30 Aug 2026"]);
  }

  // 2 — Architecture
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "The contract does not care what gets delivered", "One protocol, many adapters", 2);

    // Connectors first so they render behind the nodes.
    for (const x of [300, 590, 880]) {
      s.shapes.add({ geometry: "line", position: { left: x, top: 348, width: 72, height: 0 }, fill: "none", line: { style: "solid", fill: C.blueStrong, width: 4 } });
      addText(s, "›", x + 20, 320, 32, 48, { size: 42, bold: true, color: C.blueStrong, align: "center" });
    }

    const nodes = [
      ["1", "INTENT", "“Bring drinks to\nthe demo venue.”"],
      ["2", "ON-CHAIN GATE", "Lock funds. Approve\nspec + exact quote."],
      ["3", "WEB ADAPTER", "Search, checkout,\ncard, email 3DS."],
      ["4", "PHYSICAL PROOF", "Order status +\nhuman receipt."],
    ];
    nodes.forEach((n, i) => {
      const x = 72 + i * 290;
      box(s, x, 232, 230, 266, i === 1 ? "#EAF6FC" : C.light, i === 1 ? C.blueStrong : C.rule, 22);
      addText(s, n[0], x + 22, 254, 46, 46, { size: 34, bold: true, color: C.blueStrong });
      addText(s, n[1], x + 22, 322, 186, 22, { size: 14, bold: true, color: C.muted });
      addText(s, n[2], x + 22, 364, 188, 80, { size: 22, bold: true, lineSpacing: 1.05 });
    });
    addText(s, "Food today. Local merch tomorrow. The program only sees approved hashes, amounts, and lifecycle events.", 162, 550, 956, 58, { size: 24, color: C.muted, align: "center" });
    addFooter(s);
    notes(s,
      "Walk left to right. The Solana program is stable while the off-chain adapter changes. In this demo, the adapter was Glovo. The same contract can govern food, local print, handmade goods, or a manual fulfillment path.",
      ["Repository architecture and agent adapter configuration", "agent/out/chain-job.json"]);
  }

  // 3 — Safety gates
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "Three planes, one verifiable fulfillment lifecycle", "Builder architecture", 3);

    // Cross-plane links first so they stay behind the architecture surfaces.
    addRule(s, 392, 374, 52, C.blueStrong, 4);
    addText(s, "↔", 399, 346, 38, 44, { size: 30, bold: true, color: C.blueStrong, align: "center" });
    addRule(s, 836, 374, 52, C.blueStrong, 4);
    addText(s, "↔", 843, 346, 38, 44, { size: 30, bold: true, color: C.blueStrong, align: "center" });

    const planes = [
      {
        x: 72,
        fill: "#EAF6FC",
        edge: C.blueStrong,
        kicker: "CONTROL PLANE",
        title: "Solana + Anchor",
        lines: ["Campaign + vault PDAs", "SPL-token escrow", "Quote/spec hashes", "Lifecycle transactions"],
      },
      {
        x: 444,
        fill: C.light,
        edge: C.rule,
        kicker: "EXECUTION PLANE",
        title: "Local agent",
        lines: ["Adapter policy runner", "Persistent browser", "Human checkpoints", "AgentMail 3DS input"],
      },
      {
        x: 888,
        fill: C.greenLight,
        edge: C.green,
        kicker: "EVIDENCE PLANE",
        title: "Proof artifacts",
        lines: ["Quote + order ID", "Screenshots + status", "Payment audit", "Delivery/photo hash"],
      },
    ];
    planes.forEach((pl) => {
      box(s, pl.x, 196, pl.x === 444 ? 392 : 320, 372, pl.fill, pl.edge, 22);
      addText(s, pl.kicker, pl.x + 24, 224, pl.x === 444 ? 344 : 272, 22, { size: 14, bold: true, color: pl.x === 888 ? "#167B60" : C.blueStrong });
      addText(s, pl.title, pl.x + 24, 266, pl.x === 444 ? 344 : 272, 42, { size: 30, bold: true });
      pl.lines.forEach((line, i) => {
        addText(s, "—", pl.x + 24, 340 + i * 48, 22, 26, { size: 18, bold: true, color: pl.edge === C.rule ? C.muted : pl.edge });
        addText(s, line, pl.x + 54, 340 + i * 48, pl.x === 444 ? 306 : 238, 28, { size: 20, bold: true });
      });
    });
    addText(s, "Boundary rule: card secrets, OTPs, browser cookies, addresses, and raw email bodies stay off-chain.", 140, 606, 1000, 34, { size: 22, bold: true, color: C.red, align: "center" });
    addFooter(s);
    notes(s,
      "This is the implementation split. The Anchor program is the control plane; it owns escrow and approved state. The local agent is the execution plane; it holds browser state and touches merchant systems. JSON evidence and hashes bridge the two. Sensitive data never crosses into Solana.",
      ["Anchor program and generated IDL in the repository", "agent/src adapter runner and browser modules", "agent/out/chain-job.json"]);
  }

  // 4 — Safety gates
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "Payment stayed human-controlled", "Safety model", 4);
    addRule(s, 158, 334, 960, C.rule, 4);
    const stages = [
      ["01", "CHECKLIST", "Venue, basket, note, cap", C.light],
      ["02", "QUOTE APPROVAL", "25.24 PLN, exact string", "#EAF6FC"],
      ["03", "PAY + 3DS", "One attempt, email challenge", C.greenLight],
    ];
    stages.forEach((st, i) => {
      const x = 98 + i * 392;
      s.shapes.add({ geometry: "ellipse", position: { left: x + 108, top: 295, width: 78, height: 78 }, fill: i === 2 ? C.green : C.blueStrong, line: { style: "solid", fill: C.white, width: 6 } });
      addText(s, st[0], x + 108, 316, 78, 36, { size: 24, bold: true, color: C.white, align: "center" });
      addText(s, st[1], x, 414, 294, 26, { size: 17, bold: true, color: C.muted, align: "center" });
      addText(s, st[2], x, 460, 294, 62, { size: 25, bold: true, align: "center", lineSpacing: 1.05 });
    });
    pill(s, "DEFAULT: PAY OFF", 84, 580, 190, C.redLight, "#9C2828");
    pill(s, "NO PAN / OTP ON-CHAIN", 294, 580, 228, C.light, C.ink);
    pill(s, "NO SILENT RETRY", 542, 580, 188, C.light, C.ink);
    pill(s, "CAP ENFORCED", 750, 580, 170, C.light, C.ink);
    pill(s, "ONE ATTEMPT", 940, 580, 154, C.light, C.ink);
    addFooter(s);
    notes(s,
      "Stress that autonomy is bounded. By default, the agent stops before payment. The human approved the exact quote. The card attempt was unique. Secrets stayed off-chain and out of the model transcript.",
      ["agent/out/quote.json", "agent/out/payment-attempt.json", "agent/out/three-ds-audit.json"]);
  }

  // 5 — Video placeholder
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "Live demo: intent → checkout → 3DS → delivery", "Video", 5);
    addImage(s, videoPosterBytes, 187, 160, 906, 510, "cover", "Poster frame from the final AI fulfillment demo video");
    const play = s.shapes.add({
      geometry: "ellipse",
      position: { left: 579, top: 342, width: 122, height: 122 },
      fill: C.blueStrong,
      line: { style: "solid", fill: C.white, width: 4 },
      shadow: "shadow-lg",
    });
    play.text.set([{ run: "▶", textStyle: { bold: true, fontSize: "48px", color: C.white }, link: { uri: VIDEO_URI, isExternal: true } }]);
    play.text.style = { fontSize: 48, bold: true, color: C.white, alignment: "center", verticalAlignment: "middle", insets: { top: 0, right: 0, bottom: 0, left: 6 }, typeface: FONT };
    const playLabel = addText(s, "PLAY 1:44 DEMO", 512, 486, 256, 42, { size: 18, bold: true, color: C.white, align: "center", vAlign: "middle", fill: C.black, insets: { top: 4, right: 8, bottom: 4, left: 8 } });
    playLabel.text.get("PLAY 1:44 DEMO").link = { uri: VIDEO_URI, isExternal: true };
    addFooter(s, "CLICK PLAY • LOCAL VIDEO COMPANION FILE");
    notes(s,
      "Click the play button to open the edited 1:44 demo clip from the presentation-assets folder. During playback, narrate only the checkpoints: basket under cap, exact approval, card attempt, email 3DS, order confirmation, and delivery.",
      ["presentation-assets/Poland Agent got hands.m4v"]);
  }

  // 6 — Checkout evidence
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "The agent built a real basket under a hard cap", "Checkout evidence", 6);
    metric(s, "3 × 1 L", "juices selected\nfor the classroom", 72, 190, 320, { valueSize: 54 });
    metric(s, "25.24 PLN", "approved landed quote", 72, 350, 320, { valueSize: 52, color: C.blueStrong });
    metric(s, "26.00 PLN", "maximum allowed", 72, 510, 320, { valueSize: 44 });
    addImage(s, checkoutBytes, 430, 176, 778, 444, "contain", "Glovo checkout showing three juices and a 25.24 PLN total");
    addFooter(s);
    notes(s,
      "Point out that the amount shown by the merchant—not a forecast—became the approved quote. The order was three one-litre juices from Duży Ben, delivered to the configured Superteam venue.",
      ["agent/out/screenshots/glovo-final-checkout.jpg", "agent/out/quote.json"]);
  }

  // 7 — 3DS
  {
    const s = p.slides.add();
    s.background.fill = C.ink;
    addHeader(s, "Email 3DS completed without exposing the OTP", "Payment authentication", 7, true);
    const cards = [
      ["1", "READ", "AgentMail detected a fresh\nApata challenge."],
      ["2", "VALIDATE", "Merchant = Glovo\nAmount = 25.24 PLN"],
      ["3", "SUBMIT ONCE", "Six digits entered only\nafter explicit approval."],
    ];
    // Back-plane connectors first.
    addRule(s, 330, 360, 130, "#52616D", 3);
    addRule(s, 820, 360, 130, "#52616D", 3);
    cards.forEach((c, i) => {
      const x = 72 + i * 400;
      box(s, x, 224, 330, 284, i === 1 ? "#173549" : "#1E252B", i === 1 ? C.blue : "#3B464F", 22);
      pill(s, c[0], x + 24, 248, 44, i === 2 ? C.green : C.blueStrong, C.white);
      addText(s, c[1], x + 24, 314, 282, 34, { size: 18, bold: true, color: C.blue });
      addText(s, c[2], x + 24, 370, 282, 88, { size: 24, bold: true, color: C.white, lineSpacing: 1.08 });
    });
    addText(s, "The audit records provider, merchant, currency, amount, mode, and completion time—never the code itself.", 144, 560, 992, 56, { size: 24, color: "#BFC8CF", align: "center" });
    addFooter(s, "APATA • EMAIL OTP • SECRET-FREE AUDIT", true);
    notes(s,
      "The mailbox was used as a constrained authentication input. The agent classified the sender, checked the amount and merchant, and submitted exactly once. The audit file contains no OTP.",
      ["agent/out/three-ds-audit.json", "agent/out/payment-auth.json"]);
  }

  // 8 — On-chain events
  {
    const s = p.slides.add();
    s.background.fill = C.ink;
    addHeader(s, "Authorization boundaries became on-chain events", "Surfpool / Solana", 8, true);
    const events = [
      ["QUOTE APPROVED", "25.24 PLN", "5pedrWb…f6Rv2", C.blue],
      ["PAYMENT AUTH", "Apata 3DS", "YWwoQjV…qevyPE", C.amber],
      ["PURCHASE", "Order 101758048957", "CjJT67j…7WTbX", C.green],
    ];
    events.forEach((e, i) => {
      const x = 72 + i * 400;
      addText(s, e[0], x, 232, 336, 22, { size: 15, bold: true, color: e[3] });
      addText(s, e[1], x, 286, 336, 76, { size: i === 2 ? 32 : 43, bold: true, color: C.white, lineSpacing: 0.95 });
      addRule(s, x, 392, 336, "#38434C", 1);
      addText(s, e[2], x, 420, 336, 34, { size: 19, bold: true, color: "#AAB4BE" });
    });
    addText(s, "Campaign", 72, 534, 180, 20, { size: 14, bold: true, color: "#8E9AA5" });
    addText(s, "84FzYjkH…QYzh7N", 72, 566, 460, 36, { size: 24, bold: true, color: C.white });
    addText(s, "Spec hash", 696, 534, 180, 20, { size: 14, bold: true, color: "#8E9AA5" });
    addText(s, "fa927741…cf0e4", 696, 566, 460, 36, { size: 24, bold: true, color: C.white });
    addFooter(s, "VIEW LOCALLY IN SURFPOOL STUDIO • 127.0.0.1:18488", true);
    notes(s,
      "The transaction signatures are real local-Solana transactions. The audience can inspect them in Surfpool Studio. Explain that the on-chain program stores lifecycle evidence and hashes—not personal delivery information or card secrets.",
      [
        "agent/out/chain-job.json",
        "Payment auth transaction: YWwoQjVTkbiEWQKEXWEtCDpKmtc1ZrUwGk9Lj547uJm5k8Fj7TJ6Bium1K9RRcy7wWoMiuAv2SSjMXyTbqevyPE",
        "Purchase transaction: CjJT67jsbsvqUqX3Vbq5yTrBvCqeNbCrqHNfZw8UdebSYhmbfLeCKHQuQq4RrW16EKgGT3AJTnbvzMrkba7WTbX",
      ]);
  }

  // 9 — Delivery
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "The physical order arrived", "Delivery evidence", 9);
    addImage(s, deliveredBytes, 72, 178, 760, 444, "contain", "Glovo order page marked Delivered for order 101758048957");
    addText(s, "DELIVERED", 886, 198, 300, 30, { size: 18, bold: true, color: C.green });
    addText(s, "15:35", 886, 252, 300, 72, { size: 62, bold: true });
    addText(s, "30 Aug 2026", 886, 326, 300, 30, { size: 23, color: C.muted });
    addRule(s, 886, 392, 300, C.rule, 1);
    addText(s, "Order ID", 886, 424, 300, 22, { size: 14, bold: true, color: C.muted });
    addText(s, "101758048957", 886, 458, 300, 34, { size: 27, bold: true });
    addText(s, "Merchant status +\nhuman receipt confirmed", 886, 532, 300, 66, { size: 23, bold: true, lineSpacing: 1.05 });
    addFooter(s);
    notes(s,
      "This run used two sources of delivery evidence: Glovo marked the order Delivered, and the recipient confirmed physical receipt. That matters because merchant status alone can be wrong. A future version should also hash a delivery photo when available.",
      ["agent/out/screenshots/glovo-delivered.jpg", "agent/out/delivery-evidence.json"]);
  }

  // 10 — Reconciliation edge case
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    addHeader(s, "The key result: settlement was blocked", "Reconciliation", 10);
    const x1 = 92, x2 = 486, x3 = 880;
    metric(s, "25.24", "approved quote\nPLN", x1, 222, 280, { valueSize: 62, color: C.blueStrong, align: "center" });
    metric(s, "26.09", "final merchant charge\nPLN", x2, 222, 280, { valueSize: 62, color: C.red, align: "center" });
    metric(s, "+0.85", "variance\nPLN", x3, 222, 280, { valueSize: 62, color: C.red, align: "center" });
    addRule(s, 372, 276, 94, C.rule, 3);
    addText(s, "→", 400, 244, 42, 52, { size: 40, bold: true, color: C.muted, align: "center" });
    addRule(s, 766, 276, 94, C.rule, 3);
    addText(s, "→", 794, 244, 42, 52, { size: 40, bold: true, color: C.muted, align: "center" });
    box(s, 184, 482, 912, 108, C.redLight, C.red, 18);
    addText(s, "SETTLEMENT BLOCKED", 214, 505, 330, 34, { size: 22, bold: true, color: "#9C2828" });
    addText(s, "The final charge was 0.09 PLN above the hard cap. Human reconciliation is required.", 544, 500, 520, 52, { size: 23, bold: true, lineSpacing: 1.05 });
    addFooter(s);
    notes(s,
      "Do not hide this edge case—it is the trust story. Glovo's final charged amount was 26.09 PLN, versus the 25.24 PLN approved quote and 26.00 PLN cap. The delivery succeeded, but settlement remained blocked pending human reconciliation.",
      ["agent/out/amount-reconciliation-exception.json", "Final Glovo order total recorded by the demo operator"]);
  }

  // 11 — Close
  {
    const s = p.slides.add();
    s.background.fill = C.white;
    s.shapes.add({ geometry: "rect", position: { left: 0, top: 0, width: 22, height: H }, fill: C.blueStrong, line: { style: "solid", fill: C.blueStrong, width: 0 } });
    addText(s, "THE THESIS", 76, 60, 320, 24, { size: 14, bold: true, color: C.blueStrong });
    addText(s, "A browser can transact where APIs do not exist.\nA protocol decides when it should.", 76, 126, 1080, 160, { size: 52, bold: true, lineSpacing: 0.94 });
    addRule(s, 80, 348, 1120, C.rule, 1);
    const next = [
      ["01", "RECONCILE", "Make mutable merchant totals\nan explicit protocol state."],
      ["02", "PROVE", "Hash photos or signed human\nreceipt when available."],
      ["03", "EXPAND", "Add local print, shops, and\nmanual fulfillment adapters."],
    ];
    next.forEach((n, i) => {
      const x = 80 + i * 384;
      addText(s, n[0], x, 398, 52, 36, { size: 25, bold: true, color: C.blueStrong });
      addText(s, n[1], x + 68, 400, 260, 26, { size: 18, bold: true, color: C.muted });
      addText(s, n[2], x + 68, 454, 278, 82, { size: 22, bold: true, lineSpacing: 1.08 });
    });
    pill(s, "LOCK", 80, 610, 100, C.light);
    addText(s, "→", 190, 608, 36, 32, { size: 25, bold: true, color: C.blueStrong, align: "center" });
    pill(s, "APPROVE SPEC HASH", 236, 610, 196, "#EAF6FC", "#126A91");
    addText(s, "→", 442, 608, 36, 32, { size: 25, bold: true, color: C.blueStrong, align: "center" });
    pill(s, "PROVE DELIVERY", 488, 610, 178, C.greenLight, "#167B60");
    addText(s, "The Solana program stayed unchanged.", 830, 614, 378, 24, { size: 18, bold: true, color: C.muted, align: "right" });
    notes(s,
      "Close on the protocol, not the delivery app. The value is a reusable authorization and proof layer for physical commerce. Wolt, Glovo, local print, or a human operator can all be adapters without changing the core contract.",
      ["Repository README talk track", "Local demo evidence under agent/out/"]);
  }

  for (const [index, slide] of p.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(path.join(RENDER, `${stem}.png`), await p.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(RENDER, `${stem}.layout.json`), await layout.text());
  }

  await writeBlob(path.join(RENDER, "deck-montage.webp"), await p.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(p);
  await pptx.save(OUT);
  console.log(`Wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
