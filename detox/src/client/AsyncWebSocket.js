const _ = require('lodash');
const WebSocket = require('ws');
const log = require('../utils/logger').child({ __filename, class: 'AsyncWebSocket' });

const EVENTS = {
  OPEN: Object.freeze({ event: 'OPEN' }),
  ERROR: Object.freeze({ event: 'ERROR' }),
  MESSAGE: Object.freeze({ event: 'MESSAGE' }),
  SEND: Object.freeze({ event: 'SEND' }),
};

class AsyncWebSocket {
  constructor(url) {
    this.log = log.child({ url });
    this.url = url;
    this.ws = undefined;
    this.inFlightPromises = {};
    this.eventCallbacks = {};
    this.messageIdCounter = 0;
  }

  async open() {
    return new Promise(async(resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = (response) => {
        this.log.trace(EVENTS.OPEN, `opened web socket to: ${this.url}`);
        resolve(response);
      };

      this.ws.onerror = (err) => {
        this.log.error({ ...EVENTS.ERROR, err }, `caught error: ${err}`);

        if (_.size(this.inFlightPromises) === 0) {
          reject(err); // TODO: check when actually this can happen ??
        } else {
          this.rejectAll(err);
        }
      };

      this.ws.onmessage = (response) => {
        this.log.trace(EVENTS.MESSAGE, response.data);

        const data = JSON.parse(response.data);
        const pendingPromise = this.inFlightPromises[data.messageId];
        if (pendingPromise) {
          pendingPromise.resolve(response.data);
          delete this.inFlightPromises[data.messageId];
        } else {
          const eventCallbacks = this.eventCallbacks[data.type];
          if (!_.isEmpty(eventCallbacks)) {
            for (const callback of eventCallbacks) {
              callback(data);
            }
          }
        }
      };
    });
  }

  async send(message, messageId) {
    if (!this.ws) {
      throw new Error(`Can't send a message on a closed websocket, init the by calling 'open()'. Message:  ${JSON.stringify(message)}`);
    }

    return new Promise(async(resolve, reject) => {
      message.messageId = messageId || this.messageIdCounter++;
      this.inFlightPromises[message.messageId] = {message, resolve, reject};
      const messageAsString = JSON.stringify(message);
      this.log.trace(EVENTS.SEND, messageAsString);
      this.ws.send(messageAsString);
    });
  }

  setEventCallback(event, callback) {
    if (_.isEmpty(this.eventCallbacks[event])) {
      this.eventCallbacks[event] = [callback];
    } else {
      this.eventCallbacks[event].push(callback);
    }
  }

  async close() {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.onclose = (message) => {
          this.ws = null;
          resolve(message);
        };

        if (this.ws.readyState !== WebSocket.CLOSED) {
          this.ws.close();
        } else {
          this.ws.onclose();
        }
      } else {
        reject(new Error(`websocket is closed, init the by calling 'open()'`));
      }
    });
  }

  isOpen() {
    if (!this.ws) {
      return false;
    }
    return this.ws.readyState === WebSocket.OPEN;
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
