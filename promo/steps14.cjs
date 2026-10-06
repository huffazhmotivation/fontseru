const setVal = (sel, v) => `(()=>{const el=${sel}; const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true})()`;
module.exports = async ({ go, ev, files, shot, sleep }) => {
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','motion'); true`);
  await go('app://local/index.html', 1680, 1050);
  await sleep(2500);
  await files('input[accept=".otf,.ttf,.woff2,.woff"]', __dirname + '/dl/Ravager-Regular.ttf');
  await sleep(2500);
  await ev(setVal(`document.querySelector('.mfs-right textarea')`, 'FontSeru'));
  await ev(`(()=>{window.__r=[...document.querySelectorAll('.mfs-right input[type=range]')].find(r=>r.max==='600'); return !!window.__r})()`);
  await ev(setVal(`window.__r`, '230'));
  await sleep(600);
  await ev(`document.querySelector('.mfs-transport .mfs-play-btn').click(); true`);
  await sleep(1500);
  await shot('r-motion');
};
