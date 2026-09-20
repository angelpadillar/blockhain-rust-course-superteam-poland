import { readFile } from 'node:fs/promises';
import { validateConfig } from './policy.mjs';
export async function settings(){
  const config=validateConfig(JSON.parse(await readFile(process.env.EDITOR_CONFIG||'/app/config/editor.json','utf8')));
  const dataDir=process.env.EDITOR_DATA_DIR||'/app/data';
  const token=(await readFile(process.env.EDITOR_TOKEN_FILE||'/run/secrets/service_token','utf8')).trim();
  let typesafeKey=null; if(process.env.TYPESAFE_KEY_FILE)typesafeKey=(await readFile(process.env.TYPESAFE_KEY_FILE,'utf8')).trim();
  return {config,dataDir,token,typesafeKey};
}
