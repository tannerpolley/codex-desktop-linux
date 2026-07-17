"use strict";

const CHANNEL = "codex-linux:github-issues";
const VERSION = 1;
const BRIDGE_MARKER = "codexLinuxGithubIssuesBridgeVersion";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function preloadBridgeProperty(ipcRendererSymbol) {
  if (typeof ipcRendererSymbol !== "string" || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(ipcRendererSymbol)) {
    throw new TypeError("IPC renderer symbol must be a simple member expression");
  }
  return `githubIssues:{request:e=>${ipcRendererSymbol}.invoke(\`${CHANNEL}\`,e)}`;
}

function findElectronBridgeExposures(source) {
  const prefix = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.exposeInMainWorld\s*\(\s*`electronBridge`\s*,\s*\{/gu;
  const matches = [];
  let match;
  while ((match = prefix.exec(source)) !== null) {
    let depth = 1;
    let quote = null;
    let escaped = false;
    let end = -1;
    for (let index = prefix.lastIndex; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "`" || character === "\"" || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) continue;
    const bodyStart = prefix.lastIndex;
    const body = source.slice(bodyStart, end);
    matches.push({ body, bodyStart, bodyEnd: end, receiver: match[1] });
    prefix.lastIndex = end + 1;
  }
  return matches;
}

function applyPreloadBridgePatch(source) {
  if (typeof source !== "string") throw new TypeError("preload source must be a string");
  if (source.includes(`${BRIDGE_MARKER}=`) || source.includes(`githubIssues:{request:e=>`)) return source;

  const candidates = findElectronBridgeExposures(source)
    .filter(({ body }) => /(?:^|,)\s*getSentryInitOptions\s*(?::|\()/u.test(body))
    .map((candidate) => ({
      ...candidate,
      ipcRenderer: candidate.body.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.invoke\s*\(/u)?.[1] ?? null,
    }))
    .filter((candidate) => candidate.ipcRenderer !== null);

  if (candidates.length !== 1) {
    warn(
      candidates.length === 0
        ? "Could not identify the electronBridge preload exposure"
        : `Found ${candidates.length} electronBridge preload exposures`,
      "GitHub Issues preload bridge patch",
    );
    return source;
  }

  const candidate = candidates[0];
  const property = preloadBridgeProperty(candidate.ipcRenderer);
  const separator = candidate.body.trimEnd().endsWith(",") ? "" : ",";
  return `${source.slice(0, candidate.bodyEnd)}${separator}${property}${source.slice(candidate.bodyEnd)}`;
}

function mainBridgeSource(ipcMainSymbol = "ipcMain") {
  if (typeof ipcMainSymbol !== "string" || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(ipcMainSymbol)) {
    throw new TypeError("IPC main symbol must be a simple member expression");
  }
  return `(function(){
const ${BRIDGE_MARKER}=${VERSION};
if(globalThis.${BRIDGE_MARKER}===${VERSION})return;
globalThis.${BRIDGE_MARKER}=${VERSION};
const codexLinuxGithubIssuesChannel=\`${CHANNEL}\`;
const codexLinuxGithubIssuesMaxStdoutBytes=8*1024*1024;
const codexLinuxGithubIssuesPending=new Map();
const codexLinuxGithubIssuesOperations=new Set([\`capabilities\`,\`listIssues\`,\`getIssue\`,\`getIssueTimelinePage\`,\`cancel\`]);
const codexLinuxGithubIssuesAdapterTimeouts=Object.freeze({capabilities:30000,listIssues:30000,getIssue:60000,getIssueTimelinePage:60000});
const codexLinuxGithubIssuesPath=require(\`node:path\`);
const codexLinuxGithubIssuesSpawn=require(\`node:child_process\`).spawn;
const codexLinuxGithubIssuesNodePath=codexLinuxGithubIssuesPath.join(process.resourcesPath,\`node-runtime\`,\`bin\`,\`node\`);
const codexLinuxGithubIssuesAdapterPath=codexLinuxGithubIssuesPath.join(process.resourcesPath,\`..\`,\`.codex-linux\`,\`features\`,\`github-issues-tab\`,\`issues-adapter.js\`);
function codexLinuxGithubIssuesRecord(value){if(value===null||typeof value!==\`object\`||Array.isArray(value))return false;const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null}
function codexLinuxGithubIssuesString(value,max,field,nonEmpty=true){if(typeof value!==\`string\`||((nonEmpty&&value.length===0)||value.length>max)||/[\\u0000-\\u001f\\u007f-\\u009f]/u.test(value))throw Error(\`invalid \${field}\`);return value}
function codexLinuxGithubIssuesOptionalString(value,max,field){if(value===null)return null;return codexLinuxGithubIssuesString(value,max,field)}
function codexLinuxGithubIssuesHost(value,nullable=false){if(nullable&&value===null)return;if(typeof value!==\`string\`||value.length===0||value.length>253||value.endsWith(\`.\`)||value.includes(\`..\`))throw Error(\`invalid host\`);const labels=value.split(\`.\`);if(labels.some((label)=>!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label)))throw Error(\`invalid host\`)}
function codexLinuxGithubIssuesRepository(value){if(value===null)return;codexLinuxGithubIssuesString(value,200,\`repository\`);const separator=value.indexOf(\`/\`);if(separator<=0||separator!==value.lastIndexOf(\`/\`)||separator===value.length-1||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.slice(0,separator))||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.slice(separator+1)))throw Error(\`invalid repository\`)}
function codexLinuxGithubIssuesFields(value,allowed){for(const key of Reflect.ownKeys(value))if(typeof key!==\`string\`||!allowed.has(key))throw Error(\`unknown request field\`)}
function codexLinuxGithubIssuesInput(operation,input){
  if(!codexLinuxGithubIssuesRecord(input))throw Error(\`input must be an object\`);
  if(operation===\`capabilities\`){codexLinuxGithubIssuesFields(input,new Set([\`host\`]));codexLinuxGithubIssuesHost(input.host,true);return}
  if(operation===\`cancel\`){codexLinuxGithubIssuesFields(input,new Set([\`targetRequestId\`]));codexLinuxGithubIssuesString(input.targetRequestId,96,\`targetRequestId\`);return}
  if(operation===\`listIssues\`){codexLinuxGithubIssuesFields(input,new Set([\`host\`,\`view\`,\`state\`,\`repository\`,\`text\`,\`cursor\`]));codexLinuxGithubIssuesHost(input.host);if(![\`assigned\`,\`authored\`,\`all\`].includes(input.view)||![\`open\`,\`closed\`,\`all\`].includes(input.state))throw Error(\`invalid list input\`);codexLinuxGithubIssuesRepository(input.repository);codexLinuxGithubIssuesString(input.text,500,\`text\`,false);codexLinuxGithubIssuesOptionalString(input.cursor,512,\`cursor\`);return}
  if(operation===\`getIssue\`){codexLinuxGithubIssuesFields(input,new Set([\`host\`,\`nodeId\`]));codexLinuxGithubIssuesHost(input.host);codexLinuxGithubIssuesString(input.nodeId,256,\`nodeId\`);return}
  if(operation===\`getIssueTimelinePage\`){codexLinuxGithubIssuesFields(input,new Set([\`host\`,\`nodeId\`,\`cursor\`]));codexLinuxGithubIssuesHost(input.host);codexLinuxGithubIssuesString(input.nodeId,256,\`nodeId\`);codexLinuxGithubIssuesString(input.cursor,512,\`cursor\`);return}
  throw Error(\`invalid operation\`);
}
function codexLinuxGithubIssuesValidate(value){
  if(!codexLinuxGithubIssuesRecord(value))throw Error(\`request must be an object\`);
  codexLinuxGithubIssuesFields(value,new Set([\`version\`,\`requestId\`,\`operation\`,\`input\`]));
  if(value.version!==1)throw Error(\`version must be 1\`);
  codexLinuxGithubIssuesString(value.requestId,96,\`requestId\`);
  if(!codexLinuxGithubIssuesOperations.has(value.operation))throw Error(\`invalid operation\`);
  codexLinuxGithubIssuesInput(value.operation,value.input);
  return {version:1,requestId:value.requestId,operation:value.operation,input:value.input};
}
function codexLinuxGithubIssuesError(code,message){
  const allowed=new Set([\`invalid-request\`,\`duplicate-request\`,\`not-found\`,\`cancelled\`,\`timeout\`,\`output-limit\`,\`adapter-failed\`,\`gh-missing\`,\`gh-upgrade-required\`,\`auth-required\`,\`unauthorized\`,\`offline\`,\`rate-limited\`,\`invalid-response\`]);
  const safeCode=allowed.has(code)?code:\`adapter-failed\`;
  const safeMessage=typeof message===\`string\`&&!/[\\u0000-\\u001f\\u007f-\\u009f]/u.test(message)&&message.length<=500?message:\`GitHub Issues request failed\`;
  return {code:safeCode,message:safeMessage};
}
function codexLinuxGithubIssuesResponse(requestId,ok,data,error){return {version:1,requestId:typeof requestId===\`string\`&&requestId.length<=96?requestId:\`invalid-request\`,ok,data:ok?codexLinuxGithubIssuesClone(data):null,error:ok?null:codexLinuxGithubIssuesError(error?.code,error?.message)}}
function codexLinuxGithubIssuesClone(value,depth=0){
  if(depth>32)throw Error(\`response too deep\`);
  if(value===null||typeof value===\`string\`||typeof value===\`number\`||typeof value===\`boolean\`)return value;
  if(Array.isArray(value))return value.map((item)=>codexLinuxGithubIssuesClone(item,depth+1));
  if(codexLinuxGithubIssuesRecord(value)){const result={};for(const key of Object.keys(value))result[key]=codexLinuxGithubIssuesClone(value[key],depth+1);return result}
  throw Error(\`response contains unsupported data\`);
}
function codexLinuxGithubIssuesParsedResponse(request,stdout){
  let parsed;try{parsed=JSON.parse(stdout.trim())}catch{return codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`invalid-response\`,\`Invalid adapter response\`))}
  if(!codexLinuxGithubIssuesRecord(parsed)||parsed.version!==1||parsed.requestId!==request.requestId||typeof parsed.ok!==\`boolean\`)return codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`invalid-response\`,\`Invalid adapter response\`));
  if(parsed.ok){try{return codexLinuxGithubIssuesResponse(request.requestId,true,parsed.data,null)}catch{return codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`invalid-response\`,\`Invalid adapter response\`))}}
  return codexLinuxGithubIssuesResponse(request.requestId,false,null,parsed.error);
}
function codexLinuxGithubIssuesTerminate(child){
  const pid=Number(child?.pid);
  if(Number.isSafeInteger(pid)&&pid>1){try{process.kill(-pid,\`SIGTERM\`);return}catch{}}
  try{child?.kill()}catch{}
}
function codexLinuxGithubIssuesTerminateAll(){for(const child of codexLinuxGithubIssuesPending.values())codexLinuxGithubIssuesTerminate(child);codexLinuxGithubIssuesPending.clear()}
process.on(\`exit\`,codexLinuxGithubIssuesTerminateAll);
function codexLinuxGithubIssuesRun(request){
  let child=null;
  try{child=codexLinuxGithubIssuesSpawn(codexLinuxGithubIssuesNodePath,[codexLinuxGithubIssuesAdapterPath],{stdio:[\`pipe\`,\`pipe\`,\`pipe\`],detached:true})}catch{return Promise.resolve(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`adapter-failed\`,\`GitHub Issues adapter failed\`)))}
  codexLinuxGithubIssuesPending.set(request.requestId,child);
  return new Promise((resolve)=>{
    let settled=false,stdout=\`\`,stdoutBytes=0;
    const timeoutMs=codexLinuxGithubIssuesAdapterTimeouts[request.operation]||30000;
    let timer;
    const finish=(response)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(response)};
    const kill=()=>codexLinuxGithubIssuesTerminate(child);
    timer=setTimeout(()=>{if(settled)return;finish(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`timeout\`,\`GitHub Issues request timed out\`)));kill()},timeoutMs);
    child.stdout?.on(\`data\`,(chunk)=>{if(settled)return;const text=String(chunk);stdoutBytes+=Buffer.byteLength(text,\`utf8\`);if(stdoutBytes>codexLinuxGithubIssuesMaxStdoutBytes){finish(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`output-limit\`,\`GitHub Issues response exceeded its size limit\`)));kill();return}stdout+=text});
    child.stderr?.on(\`data\`,()=>{if(settled)return});
    child.on(\`error\`,()=>{if(settled)return;finish(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`adapter-failed\`,\`GitHub Issues adapter failed\`)))});
    child.on(\`close\`,(code)=>{if(settled)return;if(code!==0&&stdout.trim().length===0){finish(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`adapter-failed\`,\`GitHub Issues adapter failed\`)));return}finish(codexLinuxGithubIssuesParsedResponse(request,stdout))});
    try{child.stdin.end(JSON.stringify(request))}catch{kill();finish(codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`adapter-failed\`,\`GitHub Issues adapter failed\`)))}
  });
}
async function codexLinuxGithubIssuesHandle(raw){
  let request;try{request=codexLinuxGithubIssuesValidate(raw)}catch(error){return codexLinuxGithubIssuesResponse(raw?.requestId,false,null,codexLinuxGithubIssuesError(\`invalid-request\`,\`Invalid GitHub Issues request\`))}
  if(request.operation===\`cancel\`){const target=request.input.targetRequestId;const child=codexLinuxGithubIssuesPending.get(target);if(child==null)return codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`not-found\`,\`Request is not running\`));codexLinuxGithubIssuesPending.delete(target);codexLinuxGithubIssuesTerminate(child);return codexLinuxGithubIssuesResponse(request.requestId,true,{cancelled:target},null)}
  if(codexLinuxGithubIssuesPending.has(request.requestId))return codexLinuxGithubIssuesResponse(request.requestId,false,null,codexLinuxGithubIssuesError(\`duplicate-request\`,\`Request id is already running\`));
  try{return await codexLinuxGithubIssuesRun(request)}finally{codexLinuxGithubIssuesPending.delete(request.requestId)}
}
${ipcMainSymbol}.handle(codexLinuxGithubIssuesChannel,async(_event,request)=>codexLinuxGithubIssuesHandle(request));
})();`;
}

function applyMainBridgePatch(source) {
  if (typeof source !== "string") throw new TypeError("main source must be a string");
  if (source.includes(`${BRIDGE_MARKER}=`) || source.includes(`\`${CHANNEL}\``)) return source;
  const anchors = [...source.matchAll(/((?:[A-Za-z_$][\w$]*\.)*ipcMain)\.handle\s*\(\s*`codex_desktop:check-for-updates`/gu)];
  if (anchors.length !== 1) {
    warn(
      anchors.length === 0 ? "Could not identify an existing ipcMain.handle registration" : `Found ${anchors.length} ipcMain.handle registrations`,
      "GitHub Issues main bridge patch",
    );
    return source;
  }
  const ipcMainSymbol = anchors[0][1];
  const insertAt = anchors[0].index;
  return `${source.slice(0, insertAt)}${mainBridgeSource(ipcMainSymbol)}${source.slice(insertAt)}`;
}

module.exports = {
  BRIDGE_MARKER,
  CHANNEL,
  VERSION,
  preloadBridgeProperty,
  mainBridgeSource,
  applyPreloadBridgePatch,
  applyMainBridgePatch,
};
