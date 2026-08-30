import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function requireExactConfirmation(
  message: string,
  expected: string,
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`interactive human confirmation required: ${expected}`);
  }
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(`${message}\nType ${expected}: `);
  readline.close();
  if (answer !== expected) {
    throw new Error(`human confirmation did not match ${expected}; stopped`);
  }
}
