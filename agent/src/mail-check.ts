import { listRecentAgentMailSubjects } from "./agentmail.js";
import { loadRuntimeOptions } from "./config.js";

async function main(): Promise<void> {
  const options = loadRuntimeOptions();
  if (options.allowPay || options.allowThreeDsSubmit) {
    throw new Error(
      "mail:check requires ALLOW_PAY=false and ALLOW_3DS_SUBMIT=false",
    );
  }
  if (options.mailSource !== "agentmail") {
    throw new Error("mail:check requires MAIL_SOURCE=agentmail");
  }
  const subjects = await listRecentAgentMailSubjects(options);
  console.log(`AgentMail inbox reachable: ${options.agentMailInbox}`);
  console.log(`Recent messages: ${subjects.length}`);
  for (const subject of subjects) console.log(`subject=${subject}`);
  console.log("No message bodies were fetched. No mailbox state was changed.");
  console.log("No browser, card, payment, or OTP submission action was used.");
}

main().catch((error) => {
  console.error(`MAIL CHECK FAIL CLOSED: ${(error as Error).message}`);
  process.exitCode = 1;
});
