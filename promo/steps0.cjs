module.exports = async ({ go, shot }) => { await go('http://localhost:3000/'); await shot('t0'); };
