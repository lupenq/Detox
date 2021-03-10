jest.useFakeTimers('modern');

const permaproxy = require('funpermaproxy');
const tempfile = require('tempfile');
const actions = require('./actions/actions');
const invoke = require('../invoke');
const sleep = require('../utils/sleep');
const Deferred = require('../utils/Deferred');
const { serializeError } = require('serialize-error');
const { validSession } = require('../configuration/configurations.mock');

describe('Client', () => {
  /** @type {Client} */
  let client;
  let __client;
  let bunyan;
  let log;
  let sessionConfig;
  /** @type {AsyncWebSocket} */
  let mockAws;

  beforeEach(() => {
    jest.clearAllTimers();
    sessionConfig = { ...validSession };

    jest.mock('../utils/logger');
    log = require('../utils/logger');
    log.getDetoxLevel = () => 'debug';

    const AsyncWebSocket = jest.genMockFromModule('./AsyncWebSocket');
    mockAws = new AsyncWebSocket();
    mockAws.mockBusy = () => {
      const deferred = new Deferred();
      mockAws.send.mockImplementationOnce(() => deferred.promise);
      return deferred;
    };

    mockAws.mockResponse = (type, params) => {
      mockAws.send.mockResolvedValueOnce({ type, params });
    };

    mockAws.mockSyncError = (message) => {
      mockAws.send.mockImplementation(() => {
        throw new Error(message);
      })
    };

    mockAws.mockEventCallback = (expectedEvent, ...args) => {
      mockAws.setEventCallback.mockImplementationOnce((event, callback) => {
        if (event === expectedEvent) {
          callback(...args);
        }
      });
    };

    jest.mock('./AsyncWebSocket', () => {
      return class FakeAsyncWebSocket {
        constructor() {
          return mockAws;
        }
      };
    });

    Client = require('./Client');
    __client = undefined;
    client = permaproxy(() => {
      if (!__client) {
        __client = new Client(sessionConfig);
        const sendAction = __client.sendAction.bind(__client);
        __client.sendAction = jest.fn(sendAction);
      }

      return __client;
    })
  });

  describe('.isConnected', () => {
    it('should be true if the web socket is open and the server has sent "appConnected" message', () => {
      simulateIsConnected();
      expect(client.isConnected).toBe(true);
    });

    it('should be false if the web socket is closed', () => {
      mockAws.isOpen = false;
      expect(client.isConnected).toBe(false);
    });

    it('should be false if the server has not sent the "appConnected" message', () => {
      mockAws.isOpen = true;
      expect(client.isConnected).toBe(false);
    });
  });

  describe('.connect', () => {
    it('should open the web socket', async () => {
      mockAws.mockResponse('loginSuccess');
      expect(mockAws.open).not.toHaveBeenCalled();
      await client.connect();
      expect(mockAws.open).toHaveBeenCalled();
    })

    it('should send "login" action', async () => {
      mockAws.mockResponse('loginSuccess');
      expect(mockAws.send).not.toHaveBeenCalled();
      await client.connect();
      expect(mockAws.send).toHaveBeenCalledWith(new actions.Login(validSession.sessionId));
    })

    it('should not schedule "currentStatus" query for the "login" action', async () => {
      mockAws.mockBusy();
      client.connect();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
    })
  });

  describe('.sendAction', () => {
    beforeEach(simulateIsConnected);

    it('should schedule "currentStatus" query when it takes too long', async () => {
      const { someAction } = await simulateInFlightAction();
      expect(mockAws.send).toHaveBeenCalledWith(someAction);
      expect(mockAws.send).toHaveBeenCalledTimes(1);

      mockAws.mockBusy();
      jest.advanceTimersByTime(validSession.debugSynchronization);
      await simulateManyPromisesDone();

      expect(mockAws.send).toHaveBeenCalledWith(new actions.CurrentStatus());
      expect(jest.getTimerCount()).toBe(0); // should not spam with "currentStatus" queries
    });

    it('should consistently run "currentStatus" queries when it takes too long', async () => {
      await simulateInFlightAction();

      mockAws.mockResponse('currentStatusResult', { status: 'zug-zug!' });
      jest.advanceTimersByTime(validSession.debugSynchronization);

      expect(jest.getTimerCount()).toBe(0);
      await simulateManyPromisesDone();
      expect(jest.getTimerCount()).toBe(1); // should schedule next "currentStatus"
    });

    it('should unschedule "currentStatus" query when there is a response', async () => {
      const { deferred, someAction } = await simulateInFlightAction();

      expect(jest.getTimerCount()).toBe(1);

      deferred.resolve(JSON.stringify({ type: 'whateverDone' }));
      await simulateManyPromisesDone();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should unschedule "currentStatus" query when we eventually get an error', async () => {
      const { deferred, sendPromise } = await simulateInFlightAction();
      expect(jest.getTimerCount()).toBe(1);

      deferred.reject(new Error());
      await expect(sendPromise).rejects.toThrowError();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should unschedule "currentStatus" query on unforeseen non-async errors', async () => {
      const someAction = { type: 'whatever' };
      mockAws.mockSyncError('Socket error');
      await expect(client.sendAction(someAction)).rejects.toThrow('Socket error');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should not spam with "currentStatus" queries when the previous currentStatus is not answered', async () => {
      mockAws.mockBusy();

      client.currentStatus();
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('should rethrow generic "error" message if received it from the server', async () => {
      const testError = new Error('GenericServerError');
      mockAws.mockResponse('error', { error: serializeError(testError) });

      const someAction = { type: 'whatever', params: {} };
      await expect(client.sendAction(someAction)).rejects.toThrowError('GenericServerError');
    });

    it('should pass action and action.messageId to async web socket', async () => {
      const someAction = {
        type: 'whatever',
        params: {},
        messageId: 100500,
        handle: jest.fn(),
      };

      mockAws.mockResponse('whateverDone');
      await client.sendAction(someAction);
      expect(mockAws.send).toHaveBeenCalledWith(someAction);
    });

    it('should pass the parsed response to action.handle()', async () => {
      const someAction = { type: 'whatever', params: {} };
      someAction.handle = jest.fn();

      mockAws.mockResponse('whateverDone', { foo: 'bar' });
      await client.sendAction(someAction);
      expect(someAction.handle).toHaveBeenCalledWith({
        type: 'whateverDone',
        params: {
          foo: 'bar',
        },
      });
    });

    it('should return the result from action.handle()', async () => {
      const someAction = { type: 'whatever', params: {} };
      someAction.handle = jest.fn().mockResolvedValue(42);

      mockAws.mockResponse('whateverDone');
      await expect(client.sendAction(someAction)).resolves.toBe(42);
    });
  });

  describe('wrapper methods', () => {
    describe.each([
      ['reloadReactNative', 'ready', actions.ReloadReactNative],
      ['deliverPayload', 'deliverPayloadDone', actions.DeliverPayload, { foo: 'bar' }],
      ['setSyncSettings', 'setSyncSettingsDone', actions.SetSyncSettings, { foo: 'bar' }],
      ['shake', 'shakeDeviceDone', actions.Shake],
      ['setOrientation', 'setOrientationDone', actions.SetOrientation, 'portrait'],
      ['startInstrumentsRecording', 'setRecordingStateDone', actions.SetInstrumentsRecordingState, { recordingPath: 'foo', samplingInterval: 500 }],
      ['stopInstrumentsRecording', 'setRecordingStateDone', actions.SetInstrumentsRecordingState],
      ['captureViewHierarchy', 'captureViewHierarchyDone', actions.CaptureViewHierarchy, { viewHierarchyURL: 'foo' }, {}],
      ['waitForBackground', 'waitForBackgroundDone', actions.WaitForBackground],
      ['waitForActive', 'waitForActiveDone', actions.WaitForActive],
      ['waitUntilReady', 'ready', actions.Ready],
      ['cleanup', 'cleanupDone', actions.Cleanup, true],
    ])('.%s', (methodName, expectedResponseType, Action, params, expectedResponseParams) => {
      beforeEach(simulateIsConnected);

      it(`should receive "${expectedResponseType}" from device and resolve`, async () => {
        mockAws.mockResponse(expectedResponseType, expectedResponseParams);
        await client[methodName](params);

        const action = new Action(params);
        expect(mockAws.send).toHaveBeenCalledWith(action);
      });

      it(`should throw on a wrong response from device`, async () => {
        mockAws.mockResponse('boo');
        await expect(client[methodName](params)).rejects.toThrowError();
      });
    });
  });

  it(`captureViewHierarchy() - should throw an error if the response has "captureViewHierarchyError" in params`, async () => {
    simulateIsConnected();
    mockAws.mockResponse("captureViewHierarchyDone", {
      captureViewHierarchyError: 'Test error to check',
    });

    const viewHierarchyURL = tempfile('.viewhierarchy');
    await expect(client.captureViewHierarchy({ viewHierarchyURL })).rejects.toThrowError(/Test error to check/m);
  });

  describe('.cleanup', () => {
    it('should cancel "currentStatus" query', async () => {
      await simulateInFlightAction();
      expect(jest.getTimerCount()).toBe(1);

      await client.cleanup();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should not send cleanup action if it is not connected to the app', async () => {
      await client.cleanup();
      expect(mockAws.send).not.toHaveBeenCalled();
    });

    it('should not send cleanup action if the app is crashing', async () => {
      mockAws.mockEventCallback('AppWillTerminateWithError', {
        params: { errorDetails: new Error() }
      })

      simulateIsConnected();
      mockAws.mockResponse('cleanupDone');
      await client.cleanup();
      expect(mockAws.send).not.toHaveBeenCalled();
    });
  });

  // it(`cleanup() - if connected should send cleanup action and close websocket`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("ready", {}, 1));
  //   await client.waitUntilReady();
  //   mockAws.send.mockReturnValueOnce(response("cleanupDone", {}, 2));
  //   await client.cleanup();
  //
  //   expect(mockAws.send).toHaveBeenCalledTimes(3);
  // });
  //
  // it(`cleanup() - if connected should accept appDisconnected action too`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("ready", {}, 1));
  //   await client.waitUntilReady();
  //   mockAws.send.mockReturnValueOnce(response("appDisconnected", {}, 2));
  //   await client.cleanup();
  //
  //   expect(mockAws.send).toHaveBeenCalledTimes(3);
  // });
  //
  // it(`cleanup() - if not connected should do nothing`, async () => {
  //   client = new Client(sessionConfig);
  //   mockAws.send.mockReturnValueOnce(response("cleanupDone", {}, 1));
  //   await client.cleanup();
  //
  //   expect(mockAws.send).not.toHaveBeenCalled();
  // });
  //
  // it(`cleanup() - if "connected" but mockAws is closed should do nothing`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("ready", {}, 1));
  //   await client.waitUntilReady();
  //
  //   mockAws.isOpen.mockReturnValue(false);
  //   await client.cleanup();
  //
  //   expect(mockAws.send).toHaveBeenCalledTimes(2);
  // });
  //
  // it(`execute() - "invokeResult" on an invocation object should resolve`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("invokeResult", {result: "(GREYElementInteraction)"}, 1));
  //
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await client.execute(call());
  //
  //   expect(mockAws.send).toHaveBeenCalledTimes(2);
  // });
  //
  // it(`execute() - "invokeResult" on an invocation object should return invokeResult`, async () => {
  //   const someResult = 'some_result';
  //   const someInvocationResult = { type: "invokeResult", params: { result: someResult }, messageId: 1 };
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("invokeResult", {result: someResult}, 1));
  //
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   const invokeResult = await client.execute(call());
  //
  //   expect(invokeResult).toEqual(someInvocationResult.params);
  // });
  //
  // it(`execute() - "invokeResult" on an invocation function should resolve`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("invokeResult", {result: "(GREYElementInteraction)"}, 1));
  //
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await client.execute(call);
  //
  //   expect(mockAws.send).toHaveBeenCalledTimes(2);
  // });
  //
  // it(`execute() - "testFailed" result should throw with view hierarchy`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("testFailed",  {details: "this is an error", viewHierarchy: 'mock-hierarchy'}, 1));
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.toThrowError(/View Hierarchy:\nmock-hierarchy/);
  // });
  //
  // it(`execute() - "testFailed" result should throw with view-hierarchy hint`, async () => {
  //   log.getDetoxLevel = () => 'info';
  //
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("testFailed",  {details: "this is an error", viewHierarchy: 'mock-hierarchy'}, 1));
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.toThrowError(/use log-level verbose or higher/);
  // });
  //
  // it(`execute() - "testFailed" result should throw without a view hierarchy`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("testFailed",  {details: "this is an error", viewHierarchy: undefined}, 1));
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.not.toThrowError(/View Hierarchy:/);
  // });
  //
  // it(`execute() - "error" result should throw`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(response("error", {details: "this is an error"}), 1);
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.toThrowError();
  // });
  //
  // it(`execute() - should throw if non-error is thrown`, async () => {
  //   await connect();
  //   mockAws.send.mockRejectedValueOnce("non-error");
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.toThrowError('non-error');
  // });
  //
  // it(`execute() - unsupported result should throw`, async () => {
  //   await connect();
  //   mockAws.send.mockReturnValueOnce(Promise.resolve(`{"unsupported":"unsupported"}`));
  //   const call = invoke.call(invoke.IOS.Class('GREYMatchers'), 'matcherForAccessibilityLabel:', 'test');
  //   await expect(client.execute(call)).rejects.toThrowError();
  // });
  //
  // it(`dumpPendingRequests() - should not dump if no pending requests`, async () => {
  //   await connect();
  //   client.dumpPendingRequests();
  //   expect(log.warn).not.toHaveBeenCalled();
  // });
  //
  // it(`dumpPendingRequests() - should not dump if there are only currentStatus requests (debug-synchronization)`, async () => {
  //   await connect();
  //
  //   const currentStatus = { message: new actions.CurrentStatus(), resolve: jest.fn(), reject: jest.fn() };
  //   mockAws.inFlightPromises = {
  //     [currentStatus.message.messageId]: currentStatus
  //   };
  //
  //   client.dumpPendingRequests();
  //   expect(log.warn).not.toHaveBeenCalled();
  // });
  //
  // describe('dumpPendingRequests() - if there are pending requests -', () => {
  //   beforeEach(async () => {
  //     await connect();
  //
  //     const cleanup = { message: new actions.Cleanup(), resolve: jest.fn(), reject: jest.fn() };
  //     mockAws.inFlightPromises = {
  //       [cleanup.message.messageId]: cleanup
  //     };
  //   });
  //
  //   it(`should dump generic message if not testName is specified`, async () => {
  //     client.dumpPendingRequests();
  //     expect(log.warn.mock.calls[0][0]).toEqual({ event: "PENDING_REQUESTS" });
  //     expect(log.warn.mock.calls[0][1]).toMatch(/Unresponded network requests/);
  //   });
  //
  //   it(`should dump specific message if testName is specified`, async () => {
  //     client.dumpPendingRequests({testName: "Login screen should log in"});
  //     expect(log.warn.mock.calls[0][0]).toEqual({ event: "PENDING_REQUESTS" });
  //     expect(log.warn.mock.calls[0][1]).toMatch(/Login screen should log in/);
  //   });
  //
  //   it(`should reset in flight promises`, async () => {
  //     expect(mockAws.resetInFlightPromises).not.toHaveBeenCalled();
  //     client.dumpPendingRequests();
  //     expect(mockAws.resetInFlightPromises).toHaveBeenCalled();
  //   });
  // });
  //
  // it(`save a pending error if AppWillTerminateWithError event is sent to tester`, async () => {
  //   mockAws.setEventCallback = jest.fn();
  //   await connect();
  //
  //   triggerAppWillTerminateWithError();
  //
  //   expect(client.getPendingCrashAndReset()).toBeDefined();
  //
  //   function triggerAppWillTerminateWithError() {
  //     const event = createAppWillTerminateEvent();
  //     mockAws.setEventCallback.mock.calls[0][1](event);
  //   }
  // });
  //
  // it(`should allow for a nonresponsiveness listener`, async () => {
  //   mockAws.setEventCallback = jest.fn();
  //   await connect();
  //
  //   const callback = setNonresponsiveEventCallbackMock();
  //   const event = triggerAppNonresponsiveEvent();
  //
  //   expect(callback).toHaveBeenCalledWith(event.params);
  //
  //   function setNonresponsiveEventCallbackMock() {
  //     const callback = jest.fn();
  //     mockAws.setEventCallback.mockReset();
  //     client.setNonresponsivenessListener(callback);
  //     return callback;
  //   }
  //
  //   function triggerAppNonresponsiveEvent() {
  //     const event = createAppNonresponsiveEvent();
  //     mockAws.setEventCallback.mock.calls[0][1](event);
  //     return event;
  //   }
  // });

  const createAppNonresponsiveEvent = () => ({
    type: "AppNonresponsiveDetected",
    params: {threadDump: "someThreadStacks"},
    messageId: -10001
  });

  const createAppWillTerminateEvent = () => ({
    type: "AppWillTerminateWithError",
    params: {errorDetails: "someDetails"},
    messageId: -10000
  });

  function simulateIsConnected() {
    mockAws.isOpen = true;
    mockAws.mockEventCallback('appConnected');
  }

  async function simulateInFlightAction() {
    const deferred = mockAws.mockBusy();

    const someAction = { type: 'whatever', params: {}, handle: jest.fn() };
    const sendPromise = client.sendAction(someAction);
    await Promise.resolve();
    return { sendPromise, someAction, deferred };
  }

  async function simulateManyPromisesDone() {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }
});
// describe('and it gets unresponsiveness', () => {
//   let THREAD_DUMP = 'Simulated non-responsiveness';
//
//   beforeEach(init);
//
//   beforeEach(() => {
//     const listener = client().setNonresponsivenessListener.mock.calls[0][0];
//     listener({ threadDump: THREAD_DUMP });
//   });
//
//   it('should log a warning', () =>
//     expect(logger.warn).toHaveBeenCalledWith(
//       { event: 'APP_NONRESPONSIVE' },
//       expect.stringContaining(THREAD_DUMP)
//     ));
// });
//
