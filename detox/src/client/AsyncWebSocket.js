const _ = require('lodash');
const WebSocket = require('ws');
const log = require('../utils/logger').child({ __filename, class: 'AsyncWebSocket' });
const DetoxRuntimeError = require('../errors/DetoxRuntimeError');

const EVENTS = {
  OPEN: Object.freeze({ event: 'OPEN' }),
  ERROR: Object.freeze({ event: 'ERROR' }),
  MESSAGE: Object.freeze({ event: 'MESSAGE' }),
  SEND: Object.freeze({ event: 'SEND' }),
};

class AsyncWebSocket {
  constructor(url) {
    this._log = log.child({ url });
    this._url = url;
    this._ws = undefined;
    this.inFlightPromises = {};
    this._eventCallbacks = {};
    this._messageIdCounter = 0;
  }

  async open() {
    let isOpening = true;

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._url);

      this._ws.onopen = (response) => {
        this._log.trace(EVENTS.OPEN, `opened web socket to: ${this._url}`);
        isOpening = false;
        resolve(response);
      };

      this._ws.onerror = (errorEvent) => {
        if (isOpening) {
          const error = new DetoxRuntimeError({
            message: 'Failed to open a connection to the Detox server.',
            debugInfo: errorEvent.error,
            noStack: true,
          });

          reject(error);
        } else if (_.size(this.inFlightPromises) > 0) {
          this.rejectAll(errorEvent.error);
        } else {
          log.error(EVENTS.ERROR, '%s', errorEvent.error);
        }
      };

      this._ws.onmessage = (response) => {
        this._log.trace(EVENTS.MESSAGE, response.data);

        const data = JSON.parse(response.data);
        const pendingPromise = this.inFlightPromises[data.messageId];
        if (pendingPromise) {
          pendingPromise.resolve(response.data);
          delete this.inFlightPromises[data.messageId];
        } else {
          const eventCallbacks = this._eventCallbacks[data.type];
          if (!_.isEmpty(eventCallbacks)) {
            for (const callback of eventCallbacks) {
              callback(data);
            }
          }
        }
      };
    });
  }

  async close() {
    return new Promise((resolve, reject) => {
      if (this._ws) {
        this._ws.onclose = (message) => {
          this._ws = null;
          resolve(message);
        };

        if (this._ws.readyState !== WebSocket.CLOSED) {
          this._ws.close();
        } else {
          this._ws.onclose();
        }
      } else {
        reject(new Error(`websocket is closed, init the by calling 'open()'`));
      }
    });
  }

  async send(message, messageId) {
    if (!this._ws) {
      throw new Error(`Can't send a message on a closed websocket, init the by calling 'open()'. Message:  ${JSON.stringify(message)}`);
    }

    return new Promise((resolve, reject) => {
      message.messageId = messageId || this._messageIdCounter++;
      this.inFlightPromises[message.messageId] = {message, resolve, reject};
      const messageAsString = JSON.stringify(message);
      this._log.trace(EVENTS.SEND, messageAsString);
      this._ws.send(messageAsString);
    });
  }

  isOpen() {
    if (!this._ws) {
      return false;
    }

    return this._ws.readyState === WebSocket.OPEN;
  }

  setEventCallback(event, callback) {
    if (_.isEmpty(this._eventCallbacks[event])) {
      this._eventCallbacks[event] = [callback];
    } else {
      this._eventCallbacks[event].push(callback);
    }
  }

  resetInFlightPromises() {
    for (const messageId of _.keys(this.inFlightPromises)) {
      delete this.inFlightPromises[messageId];
    }
  }

  rejectAll(error) {
    for (const messageId of _.keys(this.inFlightPromises)) {
      const pendingPromise = this.inFlightPromises[messageId];
      pendingPromise.reject(error);
      delete this.inFlightPromises[messageId];
    }
  }
}

module.exports = AsyncWebSocket;
