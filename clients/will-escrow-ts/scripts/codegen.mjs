// Generates src/generated from the program's IDL (programs/will_escrow/idl),
// which Codama derives from the Rust source. The IDL is the wire format; this
// script adds what a client needs on top: PDA helpers, default accounts,
// account tags and sizes, and hidden instruction discriminators.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderVisitor } from '@codama/renderers-js';
import {
  accountNode,
  accountValueNode,
  argumentValueNode,
  bottomUpTransformerVisitor,
  constantPdaSeedNodeFromString,
  createFromJson,
  instructionArgumentNode,
  numberTypeNode,
  numberValueNode,
  pdaLinkNode,
  pdaSeedValueNode,
  pdaValueNode,
  publicKeyTypeNode,
  publicKeyValueNode,
  setAccountDiscriminatorFromFieldVisitor,
  setFixedAccountSizesVisitor,
  setInstructionAccountDefaultValuesVisitor,
  sizeDiscriminatorNode,
  addPdasVisitor,
  updateAccountsVisitor,
  variablePdaSeedNode,
} from 'codama';

const IDL = new URL('../../../programs/will_escrow/idl/will_escrow.json', import.meta.url);
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

// will_escrow::PROGRAM_DATA, pinned by the vector tests.
const PROGRAM_DATA = 'CcHoibXJsxpAt7eYd3WDtMNR4dHpAZ1P8aDA4egXxGo2';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export function willEscrowCodama() {
  const codama = createFromJson(readFileSync(IDL, 'utf8'));
  codama.update(
    addPdasVisitor({
      willEscrow: [
        { name: 'config', seeds: [constantPdaSeedNodeFromString('utf8', 'config')] },
        {
          name: 'job',
          seeds: [
            constantPdaSeedNodeFromString('utf8', 'job'),
            variablePdaSeedNode('customer', publicKeyTypeNode()),
            variablePdaSeedNode('jobId', numberTypeNode('u64')),
          ],
        },
        {
          name: 'vault',
          seeds: [
            constantPdaSeedNodeFromString('utf8', 'vault'),
            variablePdaSeedNode('job', publicKeyTypeNode()),
          ],
        },
      ],
    }),
  );
  codama.update(
    updateAccountsVisitor({
      config: { pda: pdaLinkNode('config') },
      job: { pda: pdaLinkNode('job') },
    }),
  );
  codama.update(
    setAccountDiscriminatorFromFieldVisitor({
      config: { field: 'tag', value: numberValueNode(1) },
      job: { field: 'tag', value: numberValueNode(2) },
    }),
  );
  codama.update(setFixedAccountSizesVisitor());
  // The program loads an account only at its exact size with its tag.
  codama.update(
    bottomUpTransformerVisitor([
      {
        select: '[accountNode]',
        transform: (node) =>
          accountNode({
            ...node,
            discriminators: [...(node.discriminators ?? []), sizeDiscriminatorNode(node.size)],
          }),
      },
    ]),
  );
  // The discriminator is a constant, never a caller input.
  codama.update(
    bottomUpTransformerVisitor([
      {
        select: '[instructionArgumentNode]discriminator',
        transform: (node) => instructionArgumentNode({ ...node, defaultValueStrategy: 'omitted' }),
      },
    ]),
  );
  codama.update(
    setInstructionAccountDefaultValuesVisitor([
      { account: 'tokenProgram', defaultValue: publicKeyValueNode(TOKEN_PROGRAM, 'splToken') },
      { account: 'systemProgram', defaultValue: publicKeyValueNode(SYSTEM_PROGRAM, 'splSystem') },
      { account: 'programData', defaultValue: publicKeyValueNode(PROGRAM_DATA) },
      { account: 'config', defaultValue: pdaValueNode('config') },
      {
        account: 'job',
        instruction: 'createJob',
        defaultValue: pdaValueNode('job', [
          pdaSeedValueNode('customer', accountValueNode('customer')),
          pdaSeedValueNode('jobId', argumentValueNode('jobId')),
        ]),
      },
      {
        account: 'vault',
        defaultValue: pdaValueNode('vault', [pdaSeedValueNode('job', accountValueNode('job'))]),
      },
    ]),
  );
  return codama;
}

export async function render(packageFolder = PACKAGE) {
  await willEscrowCodama().accept(
    renderVisitor(packageFolder, {
      deleteFolderBeforeRendering: true,
      generatedFolder: 'src/generated',
      importExtension: 'js',
      syncPackageJson: false,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await render();
}
