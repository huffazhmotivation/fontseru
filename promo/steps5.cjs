module.exports = async ({ go, ev, files, shot, sleep, key }) => {
  await go('http://localhost:3000/?tablet=1', 1180, 820);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('http://localhost:3000/?tablet=1', 1180, 820);
  await files('input[type=file]', __dirname + '/StackSansNotch.ttf');
  await sleep(4500);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-g"]').click(); true`);
  await sleep(600);
  await key('n', 'KeyN');
  await sleep(4000);
  await shot('tablet');
};
