import test from 'node:test';
import assert from 'node:assert/strict';

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(values)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test('instance status reports unconfigured local-safe mode without an EC2 id', async () => {
  const { handler } = await import(`./index.js?unconfigured=${Date.now()}`);

  await withEnv({ GPU_INSTANCE_ID: '', GPU_WORKER_URL: 'http://localhost:3001' }, async () => {
    const response = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/instance/status',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      configured: false,
      state: 'unconfigured',
      workerReady: false,
      startable: false,
      message: 'GPU instance control is not configured.',
    });
  });
});

test('GPU instance mock env is ignored without a real EC2 id', async () => {
  const { handler } = await import(`./index.js?mockIgnored=${Date.now()}`);

  await withEnv({
    GPU_INSTANCE_ID: '',
    GPU_INSTANCE_MOCK_STATE: 'stopped',
    GPU_WORKER_URL: 'http://localhost:3001',
  }, async () => {
    const response = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/instance/status',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      configured: false,
      state: 'unconfigured',
      workerReady: false,
      startable: false,
      message: 'GPU instance control is not configured.',
    });
  });
});

test('instance status keeps the fixed worker health probe by default', async () => {
  const previousFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  globalThis.__voiceCloningEc2Client = {
    async send() {
      return {
        Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
      };
    },
  };
  const { handler } = await import(`./index.js?fixedReadiness=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-dev-fixed',
      GPU_WORKER_URL: 'http://fixed-worker.test',
      INFERENCE_WORKER_URL: 'http://inference-fleet.test',
      GPU_STATUS_READINESS_TARGET: '',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'GET' } },
        rawPath: '/api/instance/status',
      });

      assert.equal(JSON.parse(response.body).workerReady, true);
      assert.deepEqual(urls, ['http://fixed-worker.test/healthz']);
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('instance status can require the inference fleet endpoint to be reachable', async () => {
  const previousFetch = globalThis.fetch;
  const urls = [];
  let inferenceStatus = 200;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ gpt: [], sovits: [] }), {
      status: inferenceStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  globalThis.__voiceCloningEc2Client = {
    async send() {
      return {
        Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
      };
    },
  };
  const { handler } = await import(`./index.js?inferenceReadiness=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-staging-fixed',
      GPU_WORKER_URL: 'http://fixed-worker.test',
      INFERENCE_WORKER_URL: 'http://inference-fleet.test',
      GPU_STATUS_READINESS_TARGET: 'inference',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'GET' } },
        rawPath: '/api/instance/status',
      });

      assert.equal(JSON.parse(response.body).workerReady, true);
      inferenceStatus = 503;
      const unavailableResponse = await handler({
        requestContext: { http: { method: 'GET' } },
        rawPath: '/api/instance/status',
      });
      assert.equal(JSON.parse(unavailableResponse.body).workerReady, false);
      assert.deepEqual(urls, [
        'http://inference-fleet.test/models',
        'http://inference-fleet.test/models',
      ]);
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('instance start only calls EC2 start when the user-triggered request finds a stopped instance', async () => {
  const calls = [];
  const fakeEc2 = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return {
          Reservations: [{
            Instances: [{
              InstanceId: 'i-1234567890abcdef0',
              State: { Name: 'stopped' },
            }],
          }],
        };
      }
      return {
        StartingInstances: [{
          InstanceId: 'i-1234567890abcdef0',
          CurrentState: { Name: 'pending' },
          PreviousState: { Name: 'stopped' },
        }],
      };
    },
  };

  globalThis.__voiceCloningEc2Client = fakeEc2;
  const { handler } = await import(`./index.js?start=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-1234567890abcdef0',
      GPU_WORKER_URL: 'http://localhost:3001',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/start',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand', 'StartInstancesCommand']);
      assert.deepEqual(JSON.parse(response.body), {
        configured: true,
        instanceId: 'i-1234567890abcdef0',
        state: 'pending',
        previousState: 'stopped',
        workerReady: false,
        startable: false,
        started: true,
        readinessTarget: 'training',
        autoStopMinutes: 0,
      });
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('instance start is a no-op when the GPU instance is already running', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      return {
        Reservations: [{
          Instances: [{
            InstanceId: 'i-running',
            State: { Name: 'running' },
          }],
        }],
      };
    },
  };

  const { handler } = await import(`./index.js?running=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-running',
      GPU_WORKER_URL: 'http://localhost:3001',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/start',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand']);
      assert.equal(JSON.parse(response.body).started, false);
      assert.equal(JSON.parse(response.body).workerReady, true);
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('idle check stops a running GPU after configured idle minutes', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/activity/status')) {
      return new Response(JSON.stringify({
        busy: false,
        idleMs: 11 * 60 * 1000,
        lastActivityAt: Date.now() - (11 * 60 * 1000),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return {
          Reservations: [{
            Instances: [{
              InstanceId: 'i-idle',
              State: { Name: 'running' },
            }],
          }],
        };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?idleStop=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-idle',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand', 'StopInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.checked, true);
      assert.equal(body.stopped, true);
      assert.equal(body.reason, 'idle-timeout');
      assert.equal(body.idleStopMinutes, 10);
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('idle check does not stop a recently active busy running GPU', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/activity/status')) {
      return new Response(JSON.stringify({
        busy: true,
        idleMs: 2 * 60 * 1000,
        lastActivityAt: Date.now() - (2 * 60 * 1000),
        inferenceStatus: 'generating',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      return {
        Reservations: [{
          Instances: [{
            InstanceId: 'i-busy',
            State: { Name: 'running' },
          }],
        }],
      };
    },
  };

  const { handler } = await import(`./index.js?idleBusy=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-busy',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.checked, true);
      assert.equal(body.stopped, false);
      assert.equal(body.reason, 'worker-busy');
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('idle check keeps the GPU running when the inference worker was recently active on a shared worker domain', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === 'http://localhost:3001/activity/status') {
      return new Response(JSON.stringify({
        busy: false,
        idleMs: 11 * 60 * 1000,
        lastActivityAt: Date.now() - (11 * 60 * 1000),
        trainingStatus: 'idle',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (value === 'http://localhost:3001/inference/activity/status') {
      return new Response(JSON.stringify({
        busy: false,
        idleMs: 2 * 60 * 1000,
        lastActivityAt: Date.now() - (2 * 60 * 1000),
        inferenceStatus: 'idle',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      return {
        Reservations: [{
          Instances: [{
            InstanceId: 'i-inference-active',
            State: { Name: 'running' },
          }],
        }],
      };
    },
  };

  const { handler } = await import(`./index.js?inferenceRecent=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-inference-active',
      GPU_WORKER_URL: 'http://localhost:3001',
      INFERENCE_WORKER_URL: 'http://localhost:3001',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.checked, true);
      assert.equal(body.stopped, false);
      assert.equal(body.reason, 'idle-threshold-not-met');
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('idle check can pin inference activity to the original fixed GPU', async () => {
  const urls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      busy: false,
      idleMs: 2 * 60 * 1000,
      lastActivityAt: Date.now() - (2 * 60 * 1000),
      inferenceStatus: 'idle',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  globalThis.__voiceCloningEc2Client = {
    async send() {
      return { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] };
    },
  };

  const { handler } = await import(`./index.js?fixedInferenceActivity=${Date.now()}`);
  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-dev-fixed',
      GPU_WORKER_URL: 'http://shared-dev-alb.test',
      INFERENCE_WORKER_URL: 'http://shared-dev-alb.test',
      GPU_FIXED_INFERENCE_ACTIVITY_URL: 'http://shared-dev-alb.test/fixed-inference/activity/status',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(urls, [
        'http://shared-dev-alb.test/activity/status',
        'http://shared-dev-alb.test/fixed-inference/activity/status',
      ]);
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('schedule mode starts a stopped GPU inside the window and ignores activity', async () => {
  const calls = [];
  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return {
          Reservations: [{
            Instances: [{ InstanceId: 'i-sched', State: { Name: 'stopped' } }],
          }],
        };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?schedStart=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-sched',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_SCHEDULE_ENABLED: 'true',
      GPU_SCHEDULE_START_HOUR: '0',
      GPU_SCHEDULE_END_HOUR: '24',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand', 'StartInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.mode, 'schedule');
      assert.equal(body.changed, true);
      assert.equal(body.reason, 'schedule-start');
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('schedule mode stops a running GPU outside the window, ignoring activity', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  // Even a busy worker must be stopped outside the window — activity is ignored.
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/activity/status')) {
      return new Response(JSON.stringify({
        busy: true,
        idleMs: 1 * 60 * 1000,
        lastActivityAt: Date.now(),
        inferenceStatus: 'generating',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return {
          Reservations: [{
            Instances: [{ InstanceId: 'i-sched', State: { Name: 'running' } }],
          }],
        };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?schedStop=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-sched',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_SCHEDULE_ENABLED: 'true',
      // Empty window (start === end) is never "in window", so we're always outside it.
      GPU_SCHEDULE_START_HOUR: '9',
      GPU_SCHEDULE_END_HOUR: '9',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      // No activity fetch at all; stops purely on the schedule.
      assert.deepEqual(calls, ['DescribeInstancesCommand', 'StopInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.mode, 'schedule');
      assert.equal(body.changed, true);
      assert.equal(body.reason, 'schedule-stop');
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('schedule stop scales the inference ASG to zero', async () => {
  const asgCalls = [];
  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] };
      }
      return {};
    },
  };
  globalThis.__voiceCloningAutoScalingClient = {
    async send(command) {
      asgCalls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        return { AutoScalingGroups: [{ MinSize: 1, DesiredCapacity: 5 }] };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?asgStop=${Date.now()}`);
  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-sched',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_SCHEDULE_ENABLED: 'true',
      GPU_SCHEDULE_START_HOUR: '9',
      GPU_SCHEDULE_END_HOUR: '9',
      GPU_INFERENCE_ASG_NAME: 'vcs-staging-gpu-inference',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(asgCalls.map((call) => call.name), [
        'DescribeAutoScalingGroupsCommand',
        'UpdateAutoScalingGroupCommand',
      ]);
      assert.equal(asgCalls[1].input.MinSize, 0);
      assert.equal(asgCalls[1].input.DesiredCapacity, 0);
      assert.equal(JSON.parse(response.body).inferenceFleet.enabled, false);
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
    delete globalThis.__voiceCloningAutoScalingClient;
  }
});

test('terminated fixed GPU keeps the inference ASG at zero', async () => {
  const asgCalls = [];
  globalThis.__voiceCloningEc2Client = {
    async send() {
      return { Reservations: [{ Instances: [{ State: { Name: 'terminated' } }] }] };
    },
  };
  globalThis.__voiceCloningAutoScalingClient = {
    async send(command) {
      asgCalls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        return { AutoScalingGroups: [{ MinSize: 1, DesiredCapacity: 1 }] };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?asgTerminated=${Date.now()}`);
  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-terminated',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_SCHEDULE_ENABLED: 'true',
      GPU_SCHEDULE_START_HOUR: '0',
      GPU_SCHEDULE_END_HOUR: '24',
      GPU_INFERENCE_ASG_NAME: 'vcs-staging-gpu-inference',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });
      assert.equal(response.statusCode, 200);
      assert.equal(asgCalls[1].input.MinSize, 0);
      assert.equal(asgCalls[1].input.DesiredCapacity, 0);
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
    delete globalThis.__voiceCloningAutoScalingClient;
  }
});

test('starting the fixed GPU restores ASG baseline without shrinking event capacity', async () => {
  const asgCalls = [];
  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return { Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] };
      }
      return {
        StartingInstances: [{
          CurrentState: { Name: 'pending' },
          PreviousState: { Name: 'stopped' },
        }],
      };
    },
  };
  globalThis.__voiceCloningAutoScalingClient = {
    async send(command) {
      asgCalls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        return { AutoScalingGroups: [{ MinSize: 0, DesiredCapacity: 50 }] };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?asgStart=${Date.now()}`);
  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-sched',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_INFERENCE_ASG_NAME: 'vcs-staging-gpu-inference',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/start',
      });
      assert.equal(response.statusCode, 200);
      assert.equal(asgCalls[1].input.MinSize, 1);
      assert.equal(asgCalls[1].input.DesiredCapacity, 50);
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
    delete globalThis.__voiceCloningAutoScalingClient;
  }
});

test('schedule mode blocks an activity-triggered start outside the window', async () => {
  const calls = [];
  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      return {
        Reservations: [{
          Instances: [{ InstanceId: 'i-sched', State: { Name: 'stopped' } }],
        }],
      };
    },
  };

  const { handler } = await import(`./index.js?schedBlock=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-sched',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_SCHEDULE_ENABLED: 'true',
      GPU_SCHEDULE_START_HOUR: '9',
      GPU_SCHEDULE_END_HOUR: '9',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/start',
      });

      assert.equal(response.statusCode, 200);
      // Describe only — no StartInstancesCommand.
      assert.deepEqual(calls, ['DescribeInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.scheduleBlocked, true);
      assert.equal(body.started, false);
    });
  } finally {
    delete globalThis.__voiceCloningEc2Client;
  }
});

test('idle check stops a stale busy GPU after configured idle minutes', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/activity/status')) {
      return new Response(JSON.stringify({
        busy: true,
        idleMs: 60 * 60 * 1000,
        lastActivityAt: Date.now() - (60 * 60 * 1000),
        trainingStatus: 'running',
        inferenceStatus: 'idle',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return {
          Reservations: [{
            Instances: [{
              InstanceId: 'i-stale-busy',
              State: { Name: 'running' },
            }],
          }],
        };
      }
      return {};
    },
  };

  const { handler } = await import(`./index.js?staleBusy=${Date.now()}`);

  try {
    await withEnv({
      GPU_INSTANCE_ID: 'i-stale-busy',
      GPU_WORKER_URL: 'http://localhost:3001',
      GPU_IDLE_STOP_MINUTES: '10',
    }, async () => {
      const response = await handler({
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/instance/idle-check',
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, ['DescribeInstancesCommand', 'StopInstancesCommand']);
      const body = JSON.parse(response.body);
      assert.equal(body.checked, true);
      assert.equal(body.stopped, true);
      assert.equal(body.reason, 'stale-busy-timeout');
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
});

async function runIdleCheck({ env, responses }) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    const match = Object.keys(responses).sort((a, b) => b.length - a.length).find((suffix) => value.endsWith(suffix));
    const reply = match ? responses[match] : { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  };
  globalThis.__voiceCloningEc2Client = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'DescribeInstancesCommand') {
        return { Reservations: [{ Instances: [{ InstanceId: 'i-fixed', State: { Name: 'running' } }] }] };
      }
      return {};
    },
  };
  const { handler } = await import(`./index.js?gatewayIdle=${Date.now()}${Math.random()}`);
  try {
    return await withEnv({ GPU_INSTANCE_ID: 'i-fixed', GPU_WORKER_URL: 'http://alb', GPU_IDLE_STOP_MINUTES: '30', ...env }, async () => {
      const response = await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/instance/idle-check' });
      return { calls, body: JSON.parse(response.body) };
    });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__voiceCloningEc2Client;
  }
}

const IDLE_40 = { status: 200, body: { busy: false, idleMs: 40 * 60_000, lastActivityAt: Date.now() - 40 * 60_000 } };

test('idle check keeps the fixed GPU on while a live chat is open on its gateway', async () => {
  const { calls, body } = await runIdleCheck({
    env: { GPU_GATEWAY_ACTIVITY_URL: 'http://alb/api/live/session/activity' },
    responses: {
      '/activity/status': IDLE_40,
      '/api/live/session/activity': { status: 200, body: { busy: true, idleMs: 0, liveSessions: 1, lastActivityAt: Date.now() } },
    },
  });
  assert.equal(body.stopped, false);
  assert.deepEqual(calls, ['DescribeInstancesCommand']);
});

test('idle check never stops when the gateway activity cannot be read', async () => {
  const { body } = await runIdleCheck({
    env: { GPU_GATEWAY_ACTIVITY_URL: 'http://alb/api/live/session/activity' },
    responses: { '/activity/status': IDLE_40 },
  });
  assert.equal(body.stopped, false);
  assert.equal(body.reason, 'worker-unreachable');
});

test('optional inference probe: absent autoscaled GPUs do not pin the fixed GPU on', async () => {
  const { body } = await runIdleCheck({
    env: {
      INFERENCE_WORKER_URL: 'http://alb',
      GPU_IDLE_INFERENCE_PROBE: 'optional',
      GPU_GATEWAY_ACTIVITY_URL: 'http://alb/api/live/session/activity',
    },
    responses: { '/activity/status': IDLE_40, '/api/live/session/activity': IDLE_40, '/inference/activity/status': { status: 503, body: {} } },
  });
  assert.equal(body.stopped, true);
  assert.equal(body.reason, 'idle-timeout');
});

test('optional inference probe: busy autoscaled inference still keeps it on', async () => {
  const { body } = await runIdleCheck({
    env: { INFERENCE_WORKER_URL: 'http://alb', GPU_IDLE_INFERENCE_PROBE: 'optional' },
    responses: {
      '/activity/status': IDLE_40,
      '/inference/activity/status': { status: 200, body: { busy: true, idleMs: 0, lastActivityAt: Date.now() } },
    },
  });
  assert.equal(body.stopped, false);
});
