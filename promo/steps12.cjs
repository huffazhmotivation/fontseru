module.exports = async ({ go, ev, files, shot, sleep }) => {
  const fs = require('fs');
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await files('input[type=file]', __dirname + '/Ravager.fs');
  await sleep(9000);
  await ev(`window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (b) => { window.__blob = b; }, close: async () => {}, abort: async () => {} }) }); document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('.fm-filemenu-wrap button').click(); true`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Export Font')).click(); true`);
  await sleep(1500);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='TTF')?.click(); true`);
  await sleep(300);
  console.log('btns', await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>/Export/.test(t)).join('|')`));
  await ev(`[...document.querySelectorAll('button')].find(b=>/^Export (Regular|All Family)/.test(b.textContent.trim()))?.click(); true`);
  await sleep(3000); await shot('x-exp'); console.log('txt', await ev(`document.body.innerText.slice(-600)`));
  for (let i = 0; i < 400; i++) { if (await ev('!!window.__blob')) break; await sleep(1000); if (i % 20 === 0) console.log('wait', i, await ev(`[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/Generating|Packaging|%/.test(e.textContent))?.textContent`)); }
  const b64 = await ev(`(async()=>{const b=window.__blob; if(!b) return ''; const buf=new Uint8Array(await (b instanceof Blob? b : new Blob([b])).arrayBuffer()); let s=''; for(let i=0;i<buf.length;i+=32768) s+=String.fromCharCode.apply(null, buf.subarray(i,i+32768)); return btoa(s)})()`);
  fs.mkdirSync(__dirname + '/dl', { recursive: true });
  fs.writeFileSync(__dirname + '/dl/ravager-export.bin', Buffer.from(b64, 'base64'));
  console.log('bytes', b64.length);
};
