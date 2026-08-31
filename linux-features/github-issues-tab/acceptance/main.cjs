"use strict";

const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const renderer = pathToFileURL(path.join(__dirname, "..", "renderer.mjs")).href;

async function waitFor(window, expression, errors = []) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (errors.length) throw new Error(errors.join("\n"));
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true } });
  window.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
  await window.loadFile(path.join(__dirname, "index.html"));
  await window.webContents.executeJavaScript(`
    window.electronBridge={githubIssues:{request:async request=>{
      const issue={id:'I_7',number:7,title:'Acceptance issue',url:'https://github.com/a/b/issues/7',state:'OPEN',body:'Issue body',author:'octocat',repository:'a/b',labels:[{name:'bug',color:'f00'}],assignees:['octocat'],commentCount:1,comments:[{id:'C_1',body:'Issue comment',createdAt:'2026-01-01T00:00:00Z',author:'hubot'}]};
      const data=request.operation==='capabilities'?{host:'github.com',login:'octocat'}:request.operation==='listIssues'?{host:'github.com',login:'octocat',issues:[issue],pageInfo:{hasNextPage:false,endCursor:null}}:{issue};
      return {version:1,requestId:request.requestId,ok:true,data,error:null};
    }}};
    const React=require('react');
    const ReactDOM=require('react-dom/client');
    const upstreamLazy=loader=>React.lazy(()=>Promise.resolve().then(loader).then(component=>({default:component})));
    const IssuesRoute=upstreamLazy(async()=>(await import(${JSON.stringify(renderer)})).createIssuesRoute({React}));
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Suspense,{fallback:null},React.createElement(IssuesRoute)));
  `);
  await waitFor(window, "document.querySelector('[data-testid=\"issue-7\"]')!==null", errors);
  await window.webContents.executeJavaScript("document.querySelector('[data-testid=\"issue-7\"]').click()");
  await waitFor(window, "document.querySelector('[data-testid=\"issue-detail\"]')?.textContent.includes('Issue comment')===true");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("GitHub Issues renderer acceptance passed");
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
