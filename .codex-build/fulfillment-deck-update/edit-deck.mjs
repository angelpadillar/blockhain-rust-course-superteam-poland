import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const ROOT = "/Users/buena/Documents/ChatGPT/blockhain-rust-course-superteam-poland";
const TMP = path.join(ROOT, ".codex-build/fulfillment-deck-update");
const STARTER = path.join(TMP, "template-starter.pptx");
const PHOTO = path.join(TMP, "assets/IMG_2922.png");
const OUT = path.join(ROOT, "Fulfillment-Agent-Solana-Demo-Physical-Proof.pptx");
const RENDER = path.join(TMP, "final-render");

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function records(snapshot) {
  return snapshot.ndjson
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  await fs.mkdir(RENDER, { recursive: true });
  const presentation = await PresentationFile.importPptx(await FileBlob.load(STARTER));
  const photoBytes = await fs.readFile(PHOTO);

  const all = records(await presentation.inspect({
    kind: "slide,textbox,shape,image,notes,layout",
    include: "id,slide,name,title,text,textPreview,bbox,alt",
    maxChars: 100000,
  }));

  const exactText = (slideNumber, text) => {
    const rec = all.find((r) => r.slide === slideNumber && (r.text === text || r.textPreview === text));
    if (!rec) throw new Error(`Could not find slide ${slideNumber} text: ${text}`);
    return presentation.resolve(rec.id);
  };

  const slideRecord = (slideNumber) => {
    const rec = all.find((r) => r.kind === "slide" && r.slide === slideNumber);
    if (!rec) throw new Error(`Could not find slide ${slideNumber}`);
    return presentation.resolve(rec.id);
  };

  // Slide 8: keep the verified local transaction evidence and add the stable program identity.
  exactText(8, "Spec hash").text = "Program ID";
  exactText(8, "fa927741…cf0e4").text = "F1dNhkp…YAEhYb";
  exactText(8, "VIEW LOCALLY IN SURFPOOL STUDIO • 127.0.0.1:18488").text =
    "SURFPOOL REHEARSAL • PROGRAM ID F1dNhkp…YAEhYb";
  const slide8 = slideRecord(8);
  slide8.speakerNotes.append(
    "\nPresenter update: the same program ID is configured for devnet. At deck-build time, the official devnet RPC had not yet returned an executable account, so the visible slide intentionally makes no live-deployment claim.\n\n[Sources]\n- Anchor.toml\n- programs/gift_campaign/src/lib.rs\n- target/deploy/gift_campaign-keypair.json",
  );

  // Slide 9: replace platform-only status with the actual goods in the venue.
  exactText(9, "The physical order arrived").text = "The lifecycle crossed into the physical world";
  exactText(9, "Merchant status +\nhuman receipt confirmed").text = "Photo proof +\nhuman receipt confirmed";
  const imageRec = all.find((r) => r.kind === "image" && r.slide === 9);
  if (!imageRec) throw new Error("Could not find the delivery evidence image on slide 9");
  const image = presentation.resolve(imageRec.id);
  image.replace({
    blob: photoBytes,
    contentType: "image/png",
    alt: "Three delivered juice cartons photographed at the Superteam demo venue",
    fit: "cover",
  });
  image.frame = { left: 72, top: 178, width: 760, height: 444 };
  image.crop = { left: 0, top: 0.16, right: 0, bottom: 0.02 };
  image.geometry = "roundRect";
  image.borderRadius = 15;
  const slide9 = slideRecord(9);
  slide9.speakerNotes.append(
    "\nPhysical proof update: this is the user-supplied photograph of the exact three delivered cartons at the venue. Original HEIC SHA-256: 755a7079604b36c0ec8e37b46fb52f2a83cb55400dd5e136bc254f3dc319d630.\n\n[Sources]\n- /Users/buena/Downloads/IMG_2922.HEIC\n- agent/out/delivery-evidence.json",
  );

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(path.join(RENDER, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(RENDER, `${stem}.layout.json`), await layout.text());
  }
  await writeBlob(path.join(RENDER, "montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 1 }));

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(OUT);
  console.log(`Wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
