module.exports = async ({ go, ev, files, shot, sleep }) => {
  await go('http://localhost:3000/');
  await ev(`localStorage.setItem('fontseru.appMode','font'); localStorage.setItem('fontseru.tour.seen','1'); true`);
  await go('http://localhost:3000/');
  await files('input[type=file]', __dirname + '/StackSansNotch.ttf');
  await sleep(3000);
  await shot('font-a');
};
