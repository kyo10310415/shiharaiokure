const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cron = require('node-cron');

test('server registers the monthly Tokyo schedule without running sync at startup', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-23T00:00:00Z') });
  const tasks = [];
  let serviceCalls = 0;
  const module = { exports: {} };
  const app = { listen() {} };
  const quiet = new Proxy({}, { get: () => () => {} });
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), {
      module, exports: module.exports, Date, process: { env: {} }, console: quiet,
      require(name) {
        if (name === 'dotenv') return { config() {} };
        if (name === './app') return { createApp: () => app };
        if (name === './access') return { loadAccessConfig: () => ({}) };
        if (name === './googleSheets') return new Proxy({}, { get: () => () => { serviceCalls++; throw new Error('Business execution prohibited'); } });
        if (name === 'node-cron') return { schedule(expression, callback, options) {
          assert.equal(expression, '0 22 3 * *');
          assert.equal(options.timezone, 'Asia/Tokyo');
          // Bridge VM functions into the host realm used by node-cron.
          const task = cron.schedule(expression, () => callback(), options);
          tasks.push(task);
          return task;
        } };
        throw new Error('Unexpected module');
      },
    });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].getStatus(), 'idle');
    assert.equal(tasks[0].getNextRun().toISOString(), '2026-11-03T13:00:00.000Z');
    tasks[0].stop();
    assert.equal(tasks[0].getStatus(), 'stopped');
    assert.equal(serviceCalls, 0);
  } finally { for (const task of tasks) task.destroy(); }
});
