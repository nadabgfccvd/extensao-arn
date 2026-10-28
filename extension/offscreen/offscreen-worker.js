'use strict';

setInterval(() => {
  postMessage({ type: 'TICK', ts: Date.now() });
}, 1800);
