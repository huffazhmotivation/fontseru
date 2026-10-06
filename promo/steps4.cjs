const setVal = (sel, v) => `(()=>{const el=${sel}; const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true})()`;
module.exports = async ({ go, ev, files, shot, sleep, key, win }) => {
  await go('http://localhost:3000/');
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('http://localhost:3000/');
  await files('input[type=file]', __dirname + '/StackSansNotch.ttf');
  await sleep(4500);
  // motion
  await ev(`localStorage.setItem('fontseru.appMode','motion'); true`);
  await go('http://localhost:3000/');
  await sleep(2500);
  await files('input[accept=".otf,.ttf,.woff2,.woff"]', __dirname + '/StackSansNotch.ttf');
  await sleep(2000);
  await ev(setVal(`document.querySelector('.mfs-right textarea')`, 'FontSeru'));
  await ev(`(()=>{window.__r=[...document.querySelectorAll('.mfs-right input[type=range]')].find(r=>r.max==='600'); return !!window.__r})()`);
  await ev(setVal(`window.__r`, '160'));
  await sleep(600);
  await ev(`document.querySelector('.mfs-transport .mfs-play-btn').click(); true`);
  await sleep(1500);
  await shot('motion-play');
  // design
  await ev(`localStorage.setItem('fontseru.appMode','design'); true`);
  await go('http://localhost:3000/');
  await sleep(7000);
  await ev(`(()=>{const d=document.querySelector('[data-testid=design-frame]').contentDocument; const b=[...d.querySelectorAll('button')].find(b=>b.textContent.includes('Post Instagram')); b&&b.click(); return !!b})()`);
  await sleep(1500);
  await ev(`(()=>{const d=document.querySelector('[data-testid=design-frame]').contentDocument; const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Elemen'); b&&b.click(); return !!b})()`);
  await sleep(2000);
  await ev(`(()=>{const d=document.querySelector('[data-testid=design-frame]').contentDocument; const ts=['Stiker burst diskon','Stiker bulat teks']; let n=0; for(const t of ts){const el=[...d.querySelectorAll('button, [role=button]')].find(b=>b.textContent.includes(t)); if(el){el.click();n++;}} return n})()`);
  await sleep(2500);
  await shot('design-1');
};
