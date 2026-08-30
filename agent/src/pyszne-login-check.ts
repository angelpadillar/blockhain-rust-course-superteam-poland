import { pollForPyszneLoginChallenge } from "./agentmail.js";
import { loadRuntimeOptions } from "./config.js";

async function main(): Promise<void> {
  const notBeforeRaw = process.argv[2];
  if (!notBeforeRaw) {
    throw new Error(
      "usage: npm run mail:pyszne-login -- <ISO request timestamp>",
    );
  }
  const notBefore = new Date(notBeforeRaw);
  if (Number.isNaN(notBefore.valueOf())) {
    throw new Error("Pyszne login request timestamp is invalid");
  }
  const options = loadRuntimeOptions();
  if (options.allowPay || options.allowThreeDsSubmit) {
    throw new Error(
      "Pyszne login polling requires ALLOW_PAY=false and ALLOW_3DS_SUBMIT=false",
    );
  }
  if (options.mailSource !== "agentmail") {
    throw new Error("Pyszne login polling requires MAIL_SOURCE=agentmail");
  }
  const challenge = await pollForPyszneLoginChallenge(options, notBefore);
  process.stdout.write(`${JSON.stringify(challenge)}\n`);
}

main().catch((error: unknown) => {
  console.error(
    `PYSZNE LOGIN CHECK FAIL CLOSED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
