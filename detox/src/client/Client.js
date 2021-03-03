const _ = require('lodash');
const util = require('util');
const { deserializeError } = require('serialize-error');
const AsyncWebSocket = require('./AsyncWebSocket');
const actions = require('./actions/actions');
const Deferred = require('../utils/Deferred');
const DetoxInvariantError = require('../errors/DetoxInvariantError');
const log = require('../utils/logger').child({ __filename });
const { asError, createErrorWithUserStack, replaceErrorStack } = require('../utils/errorUtils');

class Client {
  constructor(config) {
    this._whenConnected = new Deferred();
    this._whenReady = new Deferred();
    this.configuration = config;
    this._slowInvocationStatusHandle = null;
    this._slowInvocationTimeout = config.debugSynchronization;
    this.successfulTestRun = true; // flag for cleanup
    this.pandingAppCrash = undefined;
    this.ws = new AsyncWebSocket(config.server);

    this.setEventCallback('appDisconnected', () => {
      this._whenConnected = new Deferred();
      this._whenReady = new Deferred();
      this.ws.rejectAll(new Error('The app has unexpectedly disconnected from Detox server'));
    });
    this.setEventCallback('appConnected', () => {
      this._whenConnected.resolve();
    });
    this.setEventCallback('ready', () => {
      this._whenReady.resolve();
    });
    this.setEventCallback('error', this._onUnhandledErrorFromServer.bind(this));
    this.setEventCallback('AppNonresponsiveDetected', this._onNonresnponsivenessEvent.bind(this));
    this.setEventCallback('AppWillTerminateWithError', ({ params }) => {
      this.pandingAppCrash = params.errorDetails;
      this.ws.rejectAll(this.pandingAppCrash);
    });
  }

  get isConnected() {
    return this._whenConnected.isResolved();
  }

  async connect() {
    await this.ws.open();
    await this.sendAction(new actions.Login(this.configuration.sessionId));
  }

  async reloadReactNative() {
    this._whenReady = new Deferred();
    await this.sendAction(new actions.ReloadReactNative());
  }

  async waitUntilReady() {
    await this._whenConnected.promise;

    // TODO: optimize traffic (!) - we can just listen for 'ready' event
    // if app always sends it upon load completion. Then this will suffice:
    // await this._whenReady.promise;

    if (!this._whenReady.isResolved()) {
      await this.sendAction(new actions.Ready());
    }
  }

  async waitForBackground() {
    await this.sendAction(new actions.WaitForBackground());
  }

  async waitForActive() {
    await this.sendAction(new actions.WaitForActive());
  }

  async captureViewHierarchy({ viewHierarchyURL }) {
    return await this.sendAction(new actions.CaptureViewHierarchy({
      viewHierarchyURL
    }));
  }

  async cleanup() {
    clearTimeout(this._slowInvocationStatusHandle);
    if (this.isConnected && !this.pandingAppCrash) {
      if(this.ws.isOpen()) {
        await this.sendAction(new actions.Cleanup(this.successfulTestRun));
      }
      this._whenConnected = new Deferred();
    }

    if (this.ws.isOpen()) {
      await this.ws.close();
    }
  }

  async currentStatus() {
    return await this.sendAction(new actions.CurrentStatus());
  }

  async setSyncSettings(params) {
    await this.sendAction(new actions.SetSyncSettings(params));
  }

  async shake() {
    await this.sendAction(new actions.Shake());
  }

  async setOrientation(orientation) {
    await this.sendAction(new actions.SetOrientation(orientation));
  }

  async startInstrumentsRecording({ recordingPath, samplingInterval }) {
    await this.sendAction(new actions.SetInstrumentsRecordingState({
      recordingPath, samplingInterval
    }));
  }

  async stopInstrumentsRecording() {
    await this.sendAction(new actions.SetInstrumentsRecordingState());
  }

  async deliverPayload(params) {
    await this.sendAction(new actions.DeliverPayload(params));
  }

  async execute(invocation) {
    if (typeof invocation === 'function') {
      invocation = invocation();
    }

    try {
      return await this.sendAction(new actions.Invoke(invocation));
    } catch (err) {
      this.successfulTestRun = false;
      throw err;
    }
  }

  getPendingCrashAndReset() {
    const crash = this.pandingAppCrash;
    this.pandingAppCrash = undefined;

    return crash;
  }

  async sendAction(action) {
    const errorWithUserStack = createErrorWithUserStack();

    try {
      return await this._doSendAction(action);
    } catch (err) {
      throw replaceErrorStack(errorWithUserStack, asError(err));
    }
  }

  async _doSendAction(action) {
    let handledResponse;

    if (this._slowInvocationTimeout && action.type !== 'login' && action.type !== 'currentStatus') {
      this._slowInvocationStatusHandle = this._scheduleSlowInvocationQuery();
    }

    try {
      const response = await this.ws.send(action, action.messageId);
      const parsedResponse = JSON.parse(response);
      if (parsedResponse && parsedResponse.type === 'error') {
        throw deserializeError(parsedResponse.params.error);
      }

      handledResponse = await action.handle(parsedResponse);
    } finally {
      clearTimeout(this._slowInvocationStatusHandle);
    }

    return handledResponse;
  }

  setEventCallback(event, callback) {
    this.ws.setEventCallback(event, callback);
  }

  _scheduleSlowInvocationQuery() {
    return setTimeout(async () => {
      if (this.isConnected) {
        log.info({ event: 'CurrentStatus' }, await this.currentStatus());
        this._slowInvocationStatusHandle = this._scheduleSlowInvocationQuery();
      }
    }, this._slowInvocationTimeout);
  }

  dumpPendingRequests({testName} = {}) {
    const messages = _.values(this.ws.inFlightPromises)
      .map(p => p.message)
      .filter(m => m.type !== 'currentStatus');

    if (_.isEmpty(messages)) {
      return;
    }

    let dump = 'App has not responded to the network requests below:';
    for (const msg of messages) {
      dump += `\n  (id = ${msg.messageId}) ${msg.type}: ${JSON.stringify(msg.params)}`;
    }

    const notice = testName
      ? `That might be the reason why the test "${testName}" has timed out.`
      : `Unresponded network requests might result in timeout errors in Detox tests.`;

    dump += `\n\n${notice}\n`;

    log.warn({ event: 'PENDING_REQUESTS'}, dump);
    this.ws.resetInFlightPromises();
  }

  _onUnhandledErrorFromServer(result) {
    if (!result || !result.params || !result.params.error) {
      const err = new DetoxInvariantError('Received an empty error message from Detox Server:\n' + util.inspect(result));
      log.error({ event: 'ERROR' }, err.toString());
    } else {
      log.error({ event: 'ERROR' }, result.params.error);
    }
  }

  _onNonresnponsivenessEvent({ params }) {
    const message = [
      'Application nonresponsiveness detected!',
      'On Android, this could imply an ANR alert, which evidently causes tests to fail.',
      'Here\'s the native main-thread stacktrace from the device, to help you out (refer to device logs for the complete thread dump):',
      params.threadDump,
      'Refer to https://developer.android.com/training/articles/perf-anr for further details.'
    ].join('\n');

    log.warn({ event: 'APP_NONRESPONSIVE' }, message);
  }
}

module.exports = Client;
